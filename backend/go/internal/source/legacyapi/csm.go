// Copyright (c) 2026, WSO2 LLC. (https://www.wso2.com).
//
// WSO2 LLC. licenses this file to you under the Apache License,
// Version 2.0 (the "License"); you may not use this file except
// in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing,
// software distributed under the License is distributed on an
// "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
// KIND, either express or implied. See the License for the
// specific language governing permissions and limitations
// under the License.

package legacyapi

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"maps"
	"net/http"
	"net/url"
	"slices"
	"strconv"
	"sync"
	"time"

	"github.com/wso2/wso2-cloud-status/backend/go/internal/config"
	"github.com/wso2/wso2-cloud-status/backend/go/internal/source"
)

// CSMType is the backend type for CSM's cloud-status API
// (csm-integration-service, behind Choreo's API gateway). It serves the
// legacy API's payloads inside ServiceNow's envelope,
// {"result": {"code": 0, "message": "success", "cloud": ..., "data": ...}},
// and takes an OAuth2 client-credentials token.
const CSMType = "csm-cloud-status"

var (
	// ErrEnvelope is wrapped by errors for a 200 whose envelope reports a
	// failure or carries no data: a failed fetch, never empty data.
	ErrEnvelope = errors.New("legacyapi: CSM envelope without data")
	// ErrThrottled is wrapped by errors for a fetch skipped, or answered
	// 429, while CSM asks the backend to wait.
	ErrThrottled = errors.New("legacyapi: CSM throttled the backend")
)

// The options a CSM backend takes. The client secret must be one reference
// to the environment ("${CSM_CLIENT_SECRET}"), never a value in the file.
var csmOptions = []string{"client_id", "client_secret", "token_url"}

// MaxRetryAfter caps how long a 429 stops a backend. It stays below the
// shipped polling.stale_after (a test holds it there), so a throttled
// backend's data is fetched again before the page marks it stale. A 429
// without a usable Retry-After waits defaultRetryAfter.
const (
	MaxRetryAfter     = 4 * time.Minute
	defaultRetryAfter = time.Minute
)

// csmSlots is how many requests one CSM backend has in flight at most, so
// the first round of polls does not reach CSM all at once.
const csmSlots = 2

type csmProvider struct {
	client   *csmClient
	location *time.Location
}

func (p csmProvider) Source(cloud string) source.Source {
	return &Source{fetcher: p.client, location: p.location, cloud: cloud}
}

// NewCSMProvider is the source.Factory for CSM's cloud-status API. Every
// cloud of the backend shares one token, one throttling circuit and its
// request slots.
func NewCSMProvider(_ string, b config.Backend, env source.Env) (source.Provider, error) {
	if err := checkCSMOptions(b); err != nil {
		return nil, err
	}
	if env.HTTPClient == nil {
		return nil, errors.New("legacyapi: nil http client")
	}
	base, err := secureURL("base_url", b.BaseURL)
	if err != nil {
		return nil, err
	}
	tokenURL, err := secureURL("token_url", b.Options["token_url"])
	if err != nil {
		return nil, err
	}
	loc, err := b.Location()
	if err != nil {
		return nil, err
	}
	client := &csmClient{
		base:      base,
		http:      env.HTTPClient,
		userAgent: env.UserAgent,
		tokens:    newTokenSource(tokenURL, b.Options["client_id"], b.Options["client_secret"], env.HTTPClient),
		throttle:  &circuit{now: time.Now},
		slots:     make(chan struct{}, csmSlots),
	}
	return csmProvider{client: client, location: loc}, nil
}

// checkCSMOptions rejects unknown or missing options, a client secret
// written in the file rather than read from the environment, and
// credentials with surrounding spaces or control characters (a secret read
// from a file with a trailing newline, for example).
func checkCSMOptions(b config.Backend) error {
	var unknown []string
	for _, k := range slices.Sorted(maps.Keys(b.Options)) {
		if !slices.Contains(csmOptions, k) {
			unknown = append(unknown, k)
		}
	}
	if len(unknown) > 0 {
		return fmt.Errorf("legacyapi: unknown CSM options %v (known: %v)", unknown, csmOptions)
	}
	for _, k := range csmOptions {
		if b.Options[k] == "" {
			return fmt.Errorf("legacyapi: CSM option %s is required", k)
		}
	}
	if !b.EnvOptions["client_secret"] {
		return errors.New("legacyapi: CSM option client_secret must be one ${NAME} reference to the environment, not a value in the file")
	}
	for _, k := range []string{"client_id", "client_secret"} {
		if !config.ValidHeaderValue(b.Options[k]) {
			return fmt.Errorf("legacyapi: CSM option %s has surrounding spaces or a control character", k)
		}
	}
	return nil
}

// secureURL checks one of the backend's URLs with config.SecureURL.
func secureURL(name, raw string) (*url.URL, error) {
	u, err := config.SecureURL(raw)
	if err != nil {
		return nil, fmt.Errorf("legacyapi: %s: %w", name, err)
	}
	return u, nil
}

// csmClient reads CSM's cloud-status API for every cloud of one backend.
type csmClient struct {
	base      *url.URL
	http      *http.Client
	userAgent string
	tokens    *tokenSource
	throttle  *circuit
	slots     chan struct{} // one value per request in flight
}

// envelope is the wrapper CSM keeps from ServiceNow; the data inside is the
// legacy API's payload, decoded by the same code.
type envelope struct {
	Result *result `json:"result"`
}

type result struct {
	Code    *int            `json:"code"`
	Message string          `json:"message"`
	Cloud   string          `json:"cloud"`
	Data    json.RawMessage `json:"data"`
}

// problem says why a result for cloud cannot be used, or "" when it can.
func (r *result) problem(cloud string) string {
	data := bytes.TrimSpace(r.Data)
	switch {
	case r.Code == nil || *r.Code != 0 || r.Message != "success":
		return fmt.Sprintf("reports code %s, message %q", codeOf(r.Code), r.Message)
	case r.Cloud != cloud:
		return fmt.Sprintf("answered for cloud %q", r.Cloud)
	case len(data) == 0 || bytes.Equal(data, []byte("null")):
		return "has no data"
	}
	return ""
}

// fetch waits for a request slot, then reads one kind for one cloud. The
// circuit is checked before and again after the wait, so a 429 that
// arrives meanwhile holds the reads still waiting.
func (c *csmClient) fetch(ctx context.Context, kind, cloud string, out any) error {
	if err := c.held(); err != nil {
		return err
	}
	select {
	case c.slots <- struct{}{}:
	case <-ctx.Done():
		return fmt.Errorf("legacyapi: waiting to read cloud-status/%s?cloud=%s: %w", kind, cloud, ctx.Err())
	}
	defer func() { <-c.slots }()
	if err := c.held(); err != nil {
		return err
	}
	token, err := c.tokens.token(ctx)
	if err != nil {
		return err
	}
	u := c.base.JoinPath("cloud-status", kind)
	u.RawQuery = url.Values{"cloud": {cloud}}.Encode()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u.String(), nil)
	if err != nil {
		return fmt.Errorf("legacyapi: build request: %w", err)
	}
	req.Header.Set("Accept", "application/json")
	req.Header.Set("User-Agent", c.userAgent)
	req.Header.Set("Authorization", "Bearer "+token)

	resp, err := c.http.Do(req)
	if err != nil {
		return fmt.Errorf("legacyapi: GET cloud-status/%s: %w", kind, err)
	}
	defer func() { _ = resp.Body.Close() }()
	body := io.LimitReader(resp.Body, maxBody)
	if err := c.check(resp, body, token); err != nil {
		return fmt.Errorf("GET cloud-status/%s?cloud=%s: %w", kind, cloud, err)
	}
	return unwrap(body, kind, cloud, out)
}

// held reports ErrThrottled while CSM asks the backend to wait.
func (c *csmClient) held() error {
	if wait := c.throttle.remaining(); wait > 0 {
		return fmt.Errorf("%w: next try in %s", ErrThrottled, wait.Round(time.Second))
	}
	return nil
}

// check turns a status other than 200 into an error: a 429 holds the whole
// backend for its Retry-After, and a 401 drops the token and holds new
// token requests for a while (tokenSource.refused). A 200 tells the token
// source its token works.
func (c *csmClient) check(resp *http.Response, body io.Reader, token string) error {
	if resp.StatusCode == http.StatusOK {
		c.tokens.accepted()
		return nil
	}
	_, _ = io.Copy(io.Discard, body)
	switch resp.StatusCode {
	case http.StatusTooManyRequests:
		wait := retryAfter(resp.Header.Get("Retry-After"), time.Now())
		c.throttle.open(wait)
		return fmt.Errorf("%w: returned 429; waiting %s", ErrThrottled, wait)
	case http.StatusUnauthorized:
		c.tokens.refused(token)
	}
	return fmt.Errorf("%w: returned %d", ErrUnexpectedStatus, resp.StatusCode)
}

// unwrap decodes the envelope and its data into out. An envelope that
// reports a failure, answers for another cloud or carries no data is a
// failed fetch.
func unwrap(body io.Reader, kind, cloud string, out any) error {
	var env envelope
	if err := json.NewDecoder(body).Decode(&env); err != nil {
		return fmt.Errorf("legacyapi: decode cloud-status/%s?cloud=%s: %w", kind, cloud, err)
	}
	if env.Result == nil {
		return fmt.Errorf("%w: cloud-status/%s?cloud=%s has no result", ErrEnvelope, kind, cloud)
	}
	if why := env.Result.problem(cloud); why != "" {
		return fmt.Errorf("%w: cloud-status/%s?cloud=%s %s", ErrEnvelope, kind, cloud, why)
	}
	if err := json.Unmarshal(env.Result.Data, out); err != nil {
		return fmt.Errorf("legacyapi: decode cloud-status/%s?cloud=%s data: %w", kind, cloud, err)
	}
	return nil
}

func codeOf(code *int) string {
	if code == nil {
		return "missing"
	}
	return strconv.Itoa(*code)
}

// retryAfter reads a Retry-After header (seconds or an HTTP date) as a wait
// within (0, MaxRetryAfter]; anything else waits defaultRetryAfter.
func retryAfter(header string, now time.Time) time.Duration {
	if wait, ok := seconds(header, MaxRetryAfter); ok {
		return wait
	}
	if at, err := http.ParseTime(header); err == nil && at.After(now) {
		return min(at.Sub(now), MaxRetryAfter)
	}
	return defaultRetryAfter
}

// seconds reads text as a whole number of seconds above zero, capped at
// limit before it becomes a Duration, so no value overflows (one beyond
// int64 counts as above the limit). ok is false for anything else.
func seconds(text string, limit time.Duration) (time.Duration, bool) {
	n, err := strconv.ParseInt(text, 10, 64)
	if (err != nil && !errors.Is(err, strconv.ErrRange)) || n <= 0 {
		return 0, false
	}
	return time.Duration(min(n, int64(limit/time.Second))) * time.Second, true
}

// circuit holds every poll of one backend while CSM asks it to wait. All
// clouds and kinds share it: a 429 to one answer is a limit on the client.
type circuit struct {
	mu    sync.Mutex
	until time.Time
	now   func() time.Time
}

func (c *circuit) open(wait time.Duration) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if until := c.now().Add(wait); until.After(c.until) {
		c.until = until
	}
}

func (c *circuit) remaining() time.Duration {
	c.mu.Lock()
	defer c.mu.Unlock()
	return max(c.until.Sub(c.now()), 0)
}
