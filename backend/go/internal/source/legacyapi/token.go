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

// ErrToken is wrapped by errors for a token the issuer would not give, or
// one the gateway refused.
var ErrToken = errors.New("legacyapi: no CSM token")

const (
	// tokenRetry is how long after a failed token request the next one
	// waits; polls in between use the cached token while it is still
	// valid. It is also the first hold after the gateway refuses a token.
	tokenRetry = 10 * time.Second
	// maxRefusedHold caps the hold after refused tokens, which doubles
	// with each refusal in a row.
	maxRefusedHold = 2 * time.Minute
	// tokenTimeout bounds one token request. The request belongs to no
	// poll: every poll waiting for it shares the answer.
	tokenTimeout = 10 * time.Second
	// maxTokenLifetime caps the expires_in a token is trusted with.
	maxTokenLifetime = 24 * time.Hour
)

// tokenSource holds one OAuth2 client-credentials token for a backend. It
// asks for a new one at half the token's lifetime, one request at a time,
// in the background while the cached token is valid, and keeps using the
// cached token while the issuer (Asgardeo, a product this page reports on)
// is down, until the token expires.
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
	retry     time.Time // no request before here, after a failure or a refusal
	lastErr   error
	refusals  int           // tokens the gateway refused in a row
	inflight  chan struct{} // closed when the request in flight ends
}

func newTokenSource(u *url.URL, id, secret string, client *http.Client) *tokenSource {
	return &tokenSource{url: u, id: id, secret: secret, http: client, now: time.Now}
}

// token returns the cached token while it is valid, starting a background
// request for the next one past half its life. Without a valid token it
// waits for the request in flight, or its own context, whichever ends
// first.
func (t *tokenSource) token(ctx context.Context) (string, error) {
	for {
		value, wait, err := t.next(ctx)
		if wait == nil {
			return value, err
		}
		select {
		case <-wait:
		case <-ctx.Done():
			return "", ctx.Err()
		}
	}
}

// next returns the token or the error to give a caller now, or a channel
// to wait on. It starts a request when one is due and none is in flight;
// the request runs on ctx's values but not its cancellation, so a caller
// that gives up does not fail the callers waiting for the same answer.
func (t *tokenSource) next(ctx context.Context) (string, <-chan struct{}, error) {
	t.mu.Lock()
	defer t.mu.Unlock()
	now := t.now()
	valid := t.value != "" && now.Before(t.expiry)
	if valid && now.Before(t.refreshAt) {
		return t.value, nil, nil
	}
	if t.inflight == nil && !now.Before(t.retry) {
		t.inflight = make(chan struct{})
		go t.refresh(context.WithoutCancel(ctx), t.inflight)
	}
	switch {
	case valid:
		return t.value, nil, nil
	case t.inflight != nil:
		return "", t.inflight, nil
	default:
		return "", nil, t.lastErr
	}
}

// refresh asks the issuer and records the answer; a failure keeps the
// cached token while it is valid. It closes done when it ends.
func (t *tokenSource) refresh(parent context.Context, done chan struct{}) {
	ctx, cancel := context.WithTimeout(parent, tokenTimeout)
	defer cancel()
	value, lifetime, err := t.request(ctx)
	t.mu.Lock()
	defer t.mu.Unlock()
	now := t.now()
	close(done)
	t.inflight = nil
	if err != nil {
		t.retry, t.lastErr = later(t.retry, now.Add(tokenRetry)), err
		return
	}
	t.value, t.refreshAt, t.expiry, t.lastErr = value, now.Add(lifetime/2), now.Add(lifetime), nil
}

// refused drops a token the gateway refused, unless a newer one replaced
// it, and holds new token requests: tokenRetry after the first refusal,
// twice as long after each refusal in a row, up to maxRefusedHold. A broken
// credential then costs a token request every two minutes, not one per
// poll.
func (t *tokenSource) refused(value string) {
	t.mu.Lock()
	defer t.mu.Unlock()
	if t.value != value {
		return
	}
	hold := tokenRetry
	for range t.refusals {
		hold = min(2*hold, maxRefusedHold)
	}
	if hold < maxRefusedHold {
		t.refusals++
	}
	t.value, t.refreshAt, t.expiry = "", time.Time{}, time.Time{}
	t.retry = later(t.retry, t.now().Add(hold))
	t.lastErr = fmt.Errorf("%w: the gateway refused the last token; the next is asked for %s after the refusal", ErrToken, hold)
}

// accepted records a read the gateway answered with 200, which ends a run
// of refusals.
func (t *tokenSource) accepted() {
	t.mu.Lock()
	defer t.mu.Unlock()
	t.refusals = 0
}

func later(a, b time.Time) time.Time {
	if a.After(b) {
		return a
	}
	return b
}

// request asks the issuer for a token with the client-credentials grant,
// the client authenticated with HTTP Basic (RFC 6749, 2.3.1). Errors name
// the status only: an issuer's error body may echo what was sent. An
// expires_in above maxTokenLifetime counts as maxTokenLifetime.
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
		AccessToken string      `json:"access_token"`
		TokenType   string      `json:"token_type"`
		ExpiresIn   json.Number `json:"expires_in"`
	}
	// The errors below name the issuer and what was wrong, never a value from
	// its answer: a decode error quotes the text it could not read, and an
	// issuer could echo a secret there.
	if err := json.NewDecoder(body).Decode(&answer); err != nil {
		return "", 0, fmt.Errorf("%w: %s sent an answer that is not a token in JSON", ErrToken, t.url.Redacted())
	}
	lifetime, ok := seconds(answer.ExpiresIn.String(), maxTokenLifetime)
	switch {
	case answer.AccessToken == "":
		return "", 0, fmt.Errorf("%w: %s sent no access_token", ErrToken, t.url.Redacted())
	case !strings.EqualFold(answer.TokenType, "bearer"):
		return "", 0, fmt.Errorf("%w: %s sent a token type other than Bearer", ErrToken, t.url.Redacted())
	case !ok:
		return "", 0, fmt.Errorf("%w: %s sent no expires_in in whole seconds above 0", ErrToken, t.url.Redacted())
	}
	return answer.AccessToken, lifetime, nil
}
