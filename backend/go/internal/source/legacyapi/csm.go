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
	"net"
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

// The options a CSM backend takes. The client secret is a reference to the
// environment ("${CSM_CLIENT_SECRET}"), never a value in the file.
var csmOptions = []string{"client_id", "client_secret", "token_url"}

// Retry-After bounds: a 429 without a usable value waits the default, and
// no answer stops a backend for longer than the cap.
const (
	defaultRetryAfter = time.Minute
	maxRetryAfter     = 10 * time.Minute
)

type csmProvider struct {
	client   *csmClient
	location *time.Location
}

func (p csmProvider) Source(cloud string) source.Source {
	return &Source{fetcher: p.client, location: p.location, cloud: cloud}
}

// NewCSMProvider is the source.Factory for CSM's cloud-status API. Every
// cloud of the backend shares one token and one throttling circuit.
func NewCSMProvider(_ string, b config.Backend, env source.Env) (source.Provider, error) {
	var unknown []string
	for _, k := range slices.Sorted(maps.Keys(b.Options)) {
		if !slices.Contains(csmOptions, k) {
			unknown = append(unknown, k)
		}
	}
	if len(unknown) > 0 {
		return nil, fmt.Errorf("legacyapi: unknown CSM options %v (known: %v)", unknown, csmOptions)
	}
	for _, k := range csmOptions {
		if b.Options[k] == "" {
			return nil, fmt.Errorf("legacyapi: CSM option %s is required", k)
		}
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
	}
	return csmProvider{client: client, location: loc}, nil
}

// secureURL accepts https, and plain http only on a loopback host (a local
// fake upstream): the token and the statuses never cross a network in clear.
func secureURL(name, raw string) (*url.URL, error) {
	u, err := url.Parse(raw)
	if err != nil {
		return nil, fmt.Errorf("legacyapi: parse %s: %w", name, err)
	}
	if u.Scheme == "https" && u.Host != "" {
		return u, nil
	}
	if u.Scheme == "http" && loopback(u.Hostname()) {
		return u, nil
	}
	return nil, fmt.Errorf("legacyapi: %s %q must be https (http only on a loopback host)", name, raw)
}

func loopback(host string) bool {
	if host == "localhost" {
		return true
	}
	ip := net.ParseIP(host)
	return ip != nil && ip.IsLoopback()
}

// csmClient reads CSM's cloud-status API for every cloud of one backend.
type csmClient struct {
	base      *url.URL
	http      *http.Client
	userAgent string
	tokens    *tokenSource
	throttle  *circuit
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

func (c *csmClient) fetch(ctx context.Context, kind, cloud string, out any) error {
	if wait := c.throttle.remaining(); wait > 0 {
		return fmt.Errorf("%w: next try in %s", ErrThrottled, wait.Round(time.Second))
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

// check turns a status other than 200 into an error: a 429 holds the whole
// backend for its Retry-After, and a 401 drops the token, so the next poll
// asks for a new one instead of resending it until it expires.
func (c *csmClient) check(resp *http.Response, body io.Reader, token string) error {
	if resp.StatusCode == http.StatusOK {
		return nil
	}
	_, _ = io.Copy(io.Discard, body)
	switch resp.StatusCode {
	case http.StatusTooManyRequests:
		wait := retryAfter(resp.Header.Get("Retry-After"), time.Now())
		c.throttle.open(wait)
		return fmt.Errorf("%w: returned 429; waiting %s", ErrThrottled, wait)
	case http.StatusUnauthorized:
		c.tokens.forget(token)
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
// within (0, maxRetryAfter]; anything else waits defaultRetryAfter.
func retryAfter(header string, now time.Time) time.Duration {
	wait := defaultRetryAfter
	if s, err := strconv.Atoi(header); err == nil && s > 0 {
		wait = time.Duration(s) * time.Second
	} else if at, err := http.ParseTime(header); err == nil && at.After(now) {
		wait = at.Sub(now)
	}
	return min(wait, maxRetryAfter)
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
