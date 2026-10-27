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
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"
)

// ErrToken is wrapped by errors for a token the issuer would not give.
var ErrToken = errors.New("legacyapi: no CSM token")

// tokenRetry is how long after a failed token request the next one waits;
// polls in between use the cached token while it is still valid.
const tokenRetry = 10 * time.Second

// tokenSource holds one OAuth2 client-credentials token for a backend. It
// asks for a new one at half the token's lifetime, one request at a time,
// and keeps using the cached token while the issuer (Asgardeo, a product
// this page reports on) is down, until the token expires.
type tokenSource struct {
	url    *url.URL
	id     string
	secret string
	http   *http.Client
	now    func() time.Time

	mu        sync.Mutex
	value     string
	refreshAt time.Time // ask for a new token from here
	expiry    time.Time // the token stops working here
	retry     time.Time // no request before here, after a failure
	lastErr   error
	inflight  chan struct{} // closed when the request in flight ends
}

func newTokenSource(u *url.URL, id, secret string, client *http.Client) *tokenSource {
	return &tokenSource{url: u, id: id, secret: secret, http: client, now: time.Now}
}

// step is what a caller does next: return value or err, wait for the
// request in flight, or ask the issuer itself.
type step struct {
	value   string
	err     error
	wait    chan struct{}
	request bool
}

func (t *tokenSource) token(ctx context.Context) (string, error) {
	for {
		s := t.next()
		switch {
		case s.request:
			return t.refresh(ctx)
		case s.wait != nil:
			select {
			case <-s.wait:
			case <-ctx.Done():
				return "", ctx.Err()
			}
		default:
			return s.value, s.err
		}
	}
}

func (t *tokenSource) next() step {
	t.mu.Lock()
	defer t.mu.Unlock()
	now := t.now()
	valid := t.value != "" && now.Before(t.expiry)
	switch {
	case valid && now.Before(t.refreshAt):
		return step{value: t.value}
	case t.inflight == nil && !now.Before(t.retry):
		t.inflight = make(chan struct{})
		return step{request: true}
	case valid:
		// Another poll is asking, or the last request failed moments ago.
		return step{value: t.value}
	case t.inflight != nil:
		return step{wait: t.inflight}
	default:
		return step{err: t.lastErr}
	}
}

// refresh asks the issuer and records the answer; a failure keeps the
// cached token while it is valid.
func (t *tokenSource) refresh(ctx context.Context) (string, error) {
	value, lifetime, err := t.request(ctx)
	t.mu.Lock()
	defer t.mu.Unlock()
	now := t.now()
	close(t.inflight)
	t.inflight = nil
	if err != nil {
		t.retry, t.lastErr = now.Add(tokenRetry), err
		if t.value != "" && now.Before(t.expiry) {
			return t.value, nil
		}
		return "", err
	}
	t.value, t.refreshAt, t.expiry, t.lastErr = value, now.Add(lifetime/2), now.Add(lifetime), nil
	return value, nil
}

// forget drops a token the gateway refused, unless a newer one replaced it.
func (t *tokenSource) forget(value string) {
	t.mu.Lock()
	defer t.mu.Unlock()
	if t.value == value {
		t.value, t.refreshAt, t.expiry = "", time.Time{}, time.Time{}
	}
}

// request asks the issuer for a token with the client-credentials grant,
// the client authenticated with HTTP Basic (RFC 6749, 2.3.1). Errors name
// the status only: an issuer's error body may echo what was sent.
func (t *tokenSource) request(ctx context.Context) (string, time.Duration, error) {
	form := url.Values{"grant_type": {"client_credentials"}}.Encode()
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, t.url.String(), strings.NewReader(form))
	if err != nil {
		return "", 0, fmt.Errorf("%w: build request: %w", ErrToken, err)
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	req.Header.Set("Accept", "application/json")
	req.SetBasicAuth(url.QueryEscape(t.id), url.QueryEscape(t.secret))

	resp, err := t.http.Do(req)
	if err != nil {
		return "", 0, fmt.Errorf("%w: %s: %w", ErrToken, t.url.Redacted(), err)
	}
	defer func() { _ = resp.Body.Close() }()
	body := io.LimitReader(resp.Body, maxBody)
	if resp.StatusCode != http.StatusOK {
		_, _ = io.Copy(io.Discard, body)
		return "", 0, fmt.Errorf("%w: %s returned %d", ErrToken, t.url.Redacted(), resp.StatusCode)
	}
	var answer struct {
		AccessToken string `json:"access_token"`
		TokenType   string `json:"token_type"`
		ExpiresIn   int64  `json:"expires_in"`
	}
	if err := json.NewDecoder(body).Decode(&answer); err != nil {
		return "", 0, fmt.Errorf("%w: decode the answer from %s: %w", ErrToken, t.url.Redacted(), err)
	}
	switch {
	case answer.AccessToken == "":
		return "", 0, fmt.Errorf("%w: %s sent no access_token", ErrToken, t.url.Redacted())
	case !strings.EqualFold(answer.TokenType, "bearer"):
		return "", 0, fmt.Errorf("%w: %s sent token type %q, not Bearer", ErrToken, t.url.Redacted(), answer.TokenType)
	case answer.ExpiresIn <= 0:
		return "", 0, fmt.Errorf("%w: %s sent no expires_in", ErrToken, t.url.Redacted())
	}
	return answer.AccessToken, time.Duration(answer.ExpiresIn) * time.Second, nil
}
