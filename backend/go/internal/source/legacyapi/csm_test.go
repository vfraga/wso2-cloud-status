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
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/wso2/wso2-cloud-status/backend/go/internal/config"
	"github.com/wso2/wso2-cloud-status/backend/go/internal/source"
)

// fakeCSM is csm-integration-service behind its gateway, as cs-tools
// 2c2711cf serves it: the captured fixtures in the envelope, a token
// endpoint, and a bearer token required on every read.
type fakeCSM struct {
	*httptest.Server
	tokens   atomic.Int32                                         // tokens issued
	reads    atomic.Int32                                         // cloud-status reads answered
	answer   func(w http.ResponseWriter, kind, cloud string) bool // overrides a read when it returns true
	lifetime int
	mu       sync.Mutex
	issued   map[string]bool
}

func newFakeCSM(t *testing.T) *fakeCSM {
	t.Helper()
	f := &fakeCSM{lifetime: 3600, issued: map[string]bool{}}
	mux := http.NewServeMux()
	mux.HandleFunc("POST /oauth2/token", func(w http.ResponseWriter, r *http.Request) {
		id, secret, ok := r.BasicAuth()
		if !ok || id != "status-page" || secret != "s3cret" || r.FormValue("grant_type") != "client_credentials" {
			http.Error(w, `{"error":"invalid_client"}`, http.StatusUnauthorized)
			return
		}
		n := f.tokens.Add(1)
		token := fmt.Sprintf("token-%d", n)
		f.mu.Lock()
		f.issued[token] = true
		f.mu.Unlock()
		w.Header().Set("Content-Type", "application/json")
		_, _ = fmt.Fprintf(w, `{"access_token":%q,"token_type":"Bearer","expires_in":%d}`, token, f.lifetime)
	})
	mux.HandleFunc("GET /cloud-status/{kind}", func(w http.ResponseWriter, r *http.Request) {
		kind, cloud := r.PathValue("kind"), r.URL.Query().Get("cloud")
		f.mu.Lock()
		ok := f.issued[strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")]
		f.mu.Unlock()
		if !ok {
			http.Error(w, `{"message":"Invalid Credentials"}`, http.StatusUnauthorized)
			return
		}
		f.reads.Add(1)
		if f.answer != nil && f.answer(w, kind, cloud) {
			return
		}
		data, err := os.ReadFile(filepath.Clean(filepath.Join(fixtureDir, cloud+"."+kind+".json")))
		if err != nil {
			http.NotFound(w, r)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = fmt.Fprintf(w, `{"result":{"code":0,"message":"success","cloud":%q,"data":%s}}`, cloud, data)
	})
	f.Server = httptest.NewServer(mux)
	t.Cleanup(f.Close)
	return f
}

func (f *fakeCSM) backend() config.Backend {
	return config.Backend{
		Type:       CSMType,
		BaseURL:    f.URL,
		Options:    map[string]string{"token_url": f.URL + "/oauth2/token", "client_id": "status-page", "client_secret": "s3cret"},
		EnvOptions: secretFromEnv,
	}
}

// secretFromEnv marks the client secret as read from the environment, as
// config records a "${NAME}" value.
var secretFromEnv = map[string]bool{"client_secret": true}

func csmSource(t *testing.T, f *fakeCSM, cloud string) *Source {
	t.Helper()
	p, err := NewCSMProvider("csm", f.backend(), source.Env{HTTPClient: &http.Client{Timeout: 2 * time.Second}, UserAgent: "statusd-test"})
	if err != nil {
		t.Fatalf("NewCSMProvider: %v", err)
	}
	src, ok := p.Source(cloud).(*Source)
	if !ok {
		t.Fatalf("Source(%s) is %T", cloud, p.Source(cloud))
	}
	return src
}

// The envelope carries the legacy payloads, so CSM reads decode to exactly
// what the legacy API's do.
func TestCSMReadsDecodeAsTheLegacyAPI(t *testing.T) {
	t.Parallel()
	csm, legacy := newFakeCSM(t), fixtureServer(t)
	client := newTestClient(t, legacy.URL, time.UTC)
	p, err := NewCSMProvider("csm", csm.backend(), source.Env{HTTPClient: &http.Client{Timeout: 2 * time.Second}})
	if err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	t.Run("clouds", func(t *testing.T) {
		for _, cloud := range []string{"agent-manager", "asgardeo", "bijira", "choreo", "choreo-eu", "devant", "moesif"} {
			t.Run(cloud, func(t *testing.T) {
				t.Parallel()
				fromCSM, fromLegacy := p.Source(cloud).(*Source), NewSource(client, cloud)
				for _, read := range []struct {
					name string
					call func(*Source) (any, error)
				}{
					{"components", func(s *Source) (any, error) { return s.Components(ctx) }},
					{"uptime", func(s *Source) (any, error) { return s.Uptime(ctx) }},
					{"incidents", func(s *Source) (any, error) { return s.Incidents(ctx) }},
				} {
					got, err := read.call(fromCSM)
					if err != nil {
						t.Fatalf("%s from CSM: %v", read.name, err)
					}
					want, err := read.call(fromLegacy)
					if err != nil {
						t.Fatalf("%s from the legacy API: %v", read.name, err)
					}
					if !reflect.DeepEqual(got, want) {
						t.Errorf("%s from CSM differs from the legacy API's", read.name)
					}
				}
			})
		}
	})
	// One token served every read of every cloud.
	if n := csm.tokens.Load(); n != 1 {
		t.Errorf("tokens issued = %d, want 1", n)
	}
}

func TestCSMEnvelopeWithoutDataIsAFailedFetch(t *testing.T) {
	t.Parallel()
	for name, body := range map[string]string{
		"no result":       `{}`,
		"failure message": `{"result":{"code":0,"message":"error","cloud":"moesif","data":{}}}`,
		"failure code":    `{"result":{"code":1,"message":"success","cloud":"moesif","data":{}}}`,
		"no code":         `{"result":{"message":"success","cloud":"moesif","data":{}}}`,
		"null data":       `{"result":{"code":0,"message":"success","cloud":"moesif","data":null}}`,
		"no data":         `{"result":{"code":0,"message":"success","cloud":"moesif"}}`,
		"another cloud":   `{"result":{"code":0,"message":"success","cloud":"choreo","data":{"x":[]}}}`,
	} {
		t.Run(name, func(t *testing.T) {
			t.Parallel()
			f := newFakeCSM(t)
			f.answer = func(w http.ResponseWriter, _, _ string) bool {
				_, _ = w.Write([]byte(body))
				return true
			}
			if _, err := csmSource(t, f, "moesif").Components(context.Background()); !errors.Is(err, ErrEnvelope) {
				t.Errorf("err = %v, want ErrEnvelope", err)
			}
		})
	}
}

func TestCSMThrottleHoldsEveryCloudOfTheBackend(t *testing.T) {
	t.Parallel()
	f := newFakeCSM(t)
	f.answer = func(w http.ResponseWriter, _, cloud string) bool {
		if cloud != "choreo" {
			return false
		}
		w.Header().Set("Retry-After", "120")
		w.WriteHeader(http.StatusTooManyRequests)
		return true
	}
	p, err := NewCSMProvider("csm", f.backend(), source.Env{HTTPClient: &http.Client{Timeout: 2 * time.Second}})
	if err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	if _, err := p.Source("choreo").Components(ctx); !errors.Is(err, ErrThrottled) {
		t.Fatalf("429: err = %v, want ErrThrottled", err)
	}
	reads := f.reads.Load()
	// Another cloud and another kind wait too, without a request.
	if _, err := p.Source("moesif").Incidents(ctx); !errors.Is(err, ErrThrottled) {
		t.Errorf("held read: err = %v, want ErrThrottled", err)
	}
	if f.reads.Load() != reads {
		t.Error("a held read reached CSM")
	}
	provider, ok := p.(csmProvider)
	if !ok {
		t.Fatalf("provider is %T", p)
	}
	if wait := provider.client.throttle.remaining(); wait <= 110*time.Second || wait > 120*time.Second {
		t.Errorf("circuit open for %s, want about 120s", wait)
	}
}

func TestRetryAfter(t *testing.T) {
	t.Parallel()
	now := time.Date(2026, 10, 27, 12, 0, 0, 0, time.UTC)
	for header, want := range map[string]time.Duration{
		"30":    30 * time.Second,
		"":      defaultRetryAfter,
		"-5":    defaultRetryAfter,
		"soon":  defaultRetryAfter,
		"86400": MaxRetryAfter,
		// Seconds that overflow a Duration, or an int64, wait the cap.
		"9300000000":           MaxRetryAfter,
		"99999999999999999999": MaxRetryAfter,
		now.Add(90 * time.Second).Format(http.TimeFormat): 90 * time.Second,
		now.Add(-time.Hour).Format(http.TimeFormat):       defaultRetryAfter,
	} {
		if got := retryAfter(header, now); got != want {
			t.Errorf("retryAfter(%q) = %s, want %s", header, got, want)
		}
	}
}

// issuer is a token endpoint whose answers the test controls.
type issuer struct {
	*httptest.Server
	requests atomic.Int32
	failing  atomic.Bool
	blocked  atomic.Bool   // while set, each answer waits for unblock
	release  chan struct{} // closed by unblock
	once     sync.Once
	lifetime atomic.Value // expires_in as sent, "1000" unless set
}

func newIssuer(t *testing.T) *issuer {
	t.Helper()
	is := &issuer{release: make(chan struct{})}
	is.lifetime.Store("1000")
	is.Server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		n := is.requests.Add(1)
		if is.blocked.Load() {
			<-is.release
		}
		if is.failing.Load() {
			http.Error(w, "down", http.StatusServiceUnavailable)
			return
		}
		_, _ = fmt.Fprintf(w, `{"access_token":"token-%d","token_type":"Bearer","expires_in":%s}`, n, is.lifetime.Load())
	}))
	t.Cleanup(is.Close)
	t.Cleanup(is.unblock) // runs first: Close waits for blocked answers
	return is
}

func (is *issuer) unblock() { is.once.Do(func() { close(is.release) }) }

// fakeClock is a clock the test moves; token refreshes read it from their
// own goroutine.
type fakeClock struct {
	mu sync.Mutex
	at time.Time
}

func newFakeClock() *fakeClock {
	return &fakeClock{at: time.Date(2026, 10, 27, 12, 0, 0, 0, time.UTC)}
}

func (c *fakeClock) now() time.Time {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.at
}

func (c *fakeClock) add(d time.Duration) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.at = c.at.Add(d)
}

// settle waits for the token request in flight, if any, to end.
func settle(ts *tokenSource) {
	ts.mu.Lock()
	inflight := ts.inflight
	ts.mu.Unlock()
	if inflight != nil {
		<-inflight
	}
}

func (is *issuer) source(t *testing.T, now func() time.Time) *tokenSource {
	t.Helper()
	u, err := url.Parse(is.URL)
	if err != nil {
		t.Fatal(err)
	}
	ts := newTokenSource(u, "id", "secret", &http.Client{Timeout: 2 * time.Second})
	ts.now = now
	return ts
}

func TestTokenRefreshesAtHalfItsLifeAndOutlivesTheIssuer(t *testing.T) {
	t.Parallel()
	is := newIssuer(t)
	clock := newFakeClock()
	ts := is.source(t, clock.now)
	ctx := context.Background()
	get := func(want string) {
		t.Helper()
		got, err := ts.token(ctx)
		if err != nil || got != want {
			t.Fatalf("token() = %q, %v; want %q", got, err, want)
		}
	}
	get("token-1")
	clock.add(400 * time.Second) // before half its life: cached
	get("token-1")
	clock.add(200 * time.Second) // past half: still served while a new one is asked for
	get("token-1")
	settle(ts)
	get("token-2")
	if n := is.requests.Load(); n != 2 {
		t.Fatalf("requests = %d, want 2", n)
	}
	// The issuer goes down: the cached token serves until it expires, and
	// the issuer is asked again only after the retry wait.
	is.failing.Store(true)
	clock.add(600 * time.Second)
	get("token-2")
	settle(ts)
	get("token-2")
	if n := is.requests.Load(); n != 3 {
		t.Errorf("requests = %d, want 3 (one failed request, then the wait)", n)
	}
	clock.add(500 * time.Second) // token-2 has expired
	if _, err := ts.token(ctx); !errors.Is(err, ErrToken) {
		t.Errorf("after expiry: err = %v, want ErrToken", err)
	}
	is.failing.Store(false)
	clock.add(tokenRetry)
	get("token-5")
}

// TestTokenRefreshesInTheBackground: past half its life, a valid token is
// served at once to every caller while one request for the next runs.
func TestTokenRefreshesInTheBackground(t *testing.T) {
	t.Parallel()
	is := newIssuer(t)
	clock := newFakeClock()
	ts := is.source(t, clock.now)
	if got, err := ts.token(context.Background()); err != nil || got != "token-1" {
		t.Fatalf("token() = %q, %v", got, err)
	}
	is.blocked.Store(true)
	clock.add(600 * time.Second)
	served := make(chan string, 5)
	go func() {
		for range cap(served) {
			got, _ := ts.token(context.Background())
			served <- got
		}
	}()
	for range cap(served) {
		select {
		case got := <-served:
			if got != "token-1" {
				t.Fatalf("served %q while the refresh runs, want token-1", got)
			}
		case <-time.After(2 * time.Second):
			t.Fatal("a caller with a valid token waited for the refresh")
		}
	}
	is.unblock()
	settle(ts)
	if got, err := ts.token(context.Background()); err != nil || got != "token-2" {
		t.Fatalf("after the refresh: token() = %q, %v; want token-2", got, err)
	}
	if n := is.requests.Load(); n != 2 {
		t.Errorf("requests = %d, want 2", n)
	}
}

// TestCancelledCallerDoesNotFailTheOthers: the caller that started the
// token request gives up; the request carries on, and the callers waiting
// for it get its token.
func TestCancelledCallerDoesNotFailTheOthers(t *testing.T) {
	t.Parallel()
	is := newIssuer(t)
	is.blocked.Store(true)
	ts := is.source(t, time.Now)
	first, cancel := context.WithCancel(context.Background())
	firstErr := make(chan error, 1)
	go func() {
		_, err := ts.token(first)
		firstErr <- err
	}()
	for is.requests.Load() == 0 {
		time.Sleep(time.Millisecond)
	}
	var wg sync.WaitGroup
	got, errs := make([]string, 5), make([]error, 5)
	for i := range got {
		wg.Go(func() { got[i], errs[i] = ts.token(context.Background()) })
	}
	time.Sleep(20 * time.Millisecond)
	cancel()
	if err := <-firstErr; !errors.Is(err, context.Canceled) {
		t.Fatalf("cancelled caller: err = %v, want context.Canceled", err)
	}
	is.unblock()
	wg.Wait()
	for i := range got {
		if got[i] != "token-1" || errs[i] != nil {
			t.Errorf("caller %d: %q, %v; want token-1", i, got[i], errs[i])
		}
	}
	if n := is.requests.Load(); n != 1 {
		t.Errorf("requests = %d, want 1", n)
	}
}

// TestHugeTokenLifetimeCountsAsADay: an expires_in that would overflow a
// Duration, or an int64, counts as 24 hours, so the token is reused rather
// than asked for again at every poll.
func TestHugeTokenLifetimeCountsAsADay(t *testing.T) {
	t.Parallel()
	for _, lifetime := range []string{"9300000000", "99999999999999999999"} {
		t.Run(lifetime, func(t *testing.T) {
			t.Parallel()
			is := newIssuer(t)
			is.lifetime.Store(lifetime)
			clock := newFakeClock()
			ts := is.source(t, clock.now)
			for range 3 {
				if got, err := ts.token(context.Background()); err != nil || got != "token-1" {
					t.Fatalf("token() = %q, %v; want token-1", got, err)
				}
				clock.add(time.Hour)
			}
			clock.add(10 * time.Hour) // 13 hours: past half a day
			_, _ = ts.token(context.Background())
			settle(ts)
			if n := is.requests.Load(); n != 2 {
				t.Errorf("requests = %d, want 2 (one, and one at half a day)", n)
			}
		})
	}
}

func TestTokenIsAskedForOnceAtATime(t *testing.T) {
	t.Parallel()
	is := newIssuer(t)
	is.blocked.Store(true)
	ts := is.source(t, time.Now)
	var wg sync.WaitGroup
	got := make([]string, 10)
	for i := range got {
		wg.Go(func() {
			got[i], _ = ts.token(context.Background())
		})
	}
	time.Sleep(50 * time.Millisecond)
	is.unblock()
	wg.Wait()
	if n := is.requests.Load(); n != 1 {
		t.Errorf("requests = %d, want 1", n)
	}
	for i, v := range got {
		if v != "token-1" {
			t.Errorf("caller %d got %q", i, v)
		}
	}
}

func TestUnauthorizedReadDropsTheToken(t *testing.T) {
	t.Parallel()
	f := newFakeCSM(t)
	var refused atomic.Bool
	f.answer = func(w http.ResponseWriter, _, _ string) bool {
		if refused.CompareAndSwap(false, true) {
			w.WriteHeader(http.StatusUnauthorized)
			return true
		}
		return false
	}
	src := csmSource(t, f, "moesif")
	clock := newFakeClock()
	src.fetcher.(*csmClient).tokens.now = clock.now
	if _, err := src.Components(context.Background()); !errors.Is(err, ErrUnexpectedStatus) {
		t.Fatalf("401: err = %v", err)
	}
	clock.add(tokenRetry)
	if _, err := src.Components(context.Background()); err != nil {
		t.Fatalf("after 401: %v", err)
	}
	if n := f.tokens.Load(); n != 2 {
		t.Errorf("tokens issued = %d, want 2", n)
	}
}

// TestRefusedTokensBackOff: while the gateway refuses every token, new
// tokens are asked for 10 s after the first refusal, then twice as long
// after each refusal in a row, up to 2 minutes; a read that succeeds starts
// the count again.
func TestRefusedTokensBackOff(t *testing.T) {
	t.Parallel()
	f := newFakeCSM(t)
	var refuse atomic.Bool
	refuse.Store(true)
	f.answer = func(w http.ResponseWriter, _, _ string) bool {
		if refuse.Load() {
			w.WriteHeader(http.StatusUnauthorized)
			return true
		}
		return false
	}
	src := csmSource(t, f, "moesif")
	clock := newFakeClock()
	src.fetcher.(*csmClient).tokens.now = clock.now
	ctx := context.Background()
	// One poll a second for ten minutes: tokens at 1, 11, 31, 71, 151, 271,
	// 391 and 511 s.
	for range 600 {
		clock.add(time.Second)
		if _, err := src.Components(ctx); err == nil {
			t.Fatal("a refused read succeeded")
		}
	}
	if n := f.tokens.Load(); n != 8 {
		t.Errorf("tokens requested in ten minutes of refusals = %d, want 8", n)
	}
	refuse.Store(false)
	clock.add(maxRefusedHold)
	if _, err := src.Components(ctx); err != nil {
		t.Fatalf("accepted read: %v", err)
	}
	refuse.Store(true)
	_, _ = src.Components(ctx)
	before := f.tokens.Load()
	clock.add(tokenRetry)
	_, _ = src.Components(ctx)
	if n := f.tokens.Load() - before; n != 1 {
		t.Errorf("after a success and one refusal, %d tokens asked for after %s, want 1", n, tokenRetry)
	}
}

// TestCSMRequestsWaitForASlot: at most csmSlots reads of one backend are in
// flight, and a read that gets a slot after a 429 does not go out, so a
// first round of polls against a throttling CSM sends no more than the
// reads already in flight.
func TestCSMRequestsWaitForASlot(t *testing.T) {
	t.Parallel()
	f := newFakeCSM(t)
	f.answer = func(w http.ResponseWriter, _, _ string) bool {
		time.Sleep(20 * time.Millisecond)
		w.Header().Set("Retry-After", "120")
		w.WriteHeader(http.StatusTooManyRequests)
		return true
	}
	p, err := NewCSMProvider("csm", f.backend(), source.Env{HTTPClient: &http.Client{Timeout: 2 * time.Second}})
	if err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	var wg sync.WaitGroup
	for _, cloud := range []string{"agent-manager", "asgardeo", "bijira", "choreo", "choreo-eu", "devant", "moesif"} {
		src := p.Source(cloud)
		wg.Go(func() { _, _ = src.Components(ctx) })
		wg.Go(func() { _, _ = src.Uptime(ctx) })
		wg.Go(func() { _, _ = src.Incidents(ctx) })
	}
	wg.Wait()
	if n := f.reads.Load(); n > csmSlots {
		t.Errorf("%d reads reached CSM, want at most the %d in flight when the first 429 came", n, csmSlots)
	}
}

func TestCSMRequestShape(t *testing.T) {
	t.Parallel()
	var token, read *http.Request
	var form url.Values
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/oauth2/token" {
			_ = r.ParseForm()
			token, form = r.Clone(context.Background()), r.PostForm
			_, _ = w.Write([]byte(`{"access_token":"abc","token_type":"bearer","expires_in":60}`))
			return
		}
		read = r.Clone(context.Background())
		_, _ = w.Write([]byte(`{"result":{"code":0,"message":"success","cloud":"choreo-eu","data":{"EU":[]}}}`))
	}))
	t.Cleanup(srv.Close)
	backend := config.Backend{Type: CSMType, BaseURL: srv.URL + "/csm/v1.0", Options: map[string]string{
		"token_url": srv.URL + "/oauth2/token", "client_id": "id", "client_secret": "s:cret",
	}, EnvOptions: secretFromEnv}
	p, err := NewCSMProvider("csm", backend, source.Env{HTTPClient: &http.Client{Timeout: 2 * time.Second}, UserAgent: "statusd-test"})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := p.Source("choreo-eu").Uptime(context.Background()); err != nil {
		t.Fatal(err)
	}
	id, secret, ok := token.BasicAuth()
	if token.Method != http.MethodPost || form.Get("grant_type") != "client_credentials" || !ok || id != "id" || secret != url.QueryEscape("s:cret") {
		t.Errorf("token request: %s grant=%q basic=%v %q %q", token.Method, form.Get("grant_type"), ok, id, secret)
	}
	if got := read.URL.String(); got != "/csm/v1.0/cloud-status/availabilities?cloud=choreo-eu" {
		t.Errorf("read URL = %s", got)
	}
	for header, want := range map[string]string{"Authorization": "Bearer abc", "Accept": "application/json", "User-Agent": "statusd-test"} {
		if got := read.Header.Get(header); got != want {
			t.Errorf("%s = %q, want %q", header, got, want)
		}
	}
}

func TestCSMProviderOptions(t *testing.T) {
	t.Parallel()
	env := source.Env{HTTPClient: &http.Client{}}
	ok := map[string]string{"token_url": "https://sts.example.com/oauth2/token", "client_id": "id", "client_secret": "secret"}
	with := func(k, v string) map[string]string {
		m := map[string]string{}
		for key, val := range ok {
			m[key] = val
		}
		if v == "" {
			delete(m, k)
		} else {
			m[k] = v
		}
		return m
	}
	const https = "must be an absolute https URL (http only on a loopback host)"
	for name, tc := range map[string]struct {
		base     string
		options  map[string]string
		wantErr  string
		inTheEnv map[string]bool
	}{
		"https":                     {"https://gw.example.com/csm/v1.0", ok, "", secretFromEnv},
		"loopback http":             {"http://127.0.0.1:18090", with("token_url", "http://localhost:18090/oauth2/token"), "", secretFromEnv},
		"plain http":                {"http://gw.example.com", ok, "base_url: \"http://gw.example.com\" " + https, secretFromEnv},
		"plain http token":          {"https://gw.example.com", with("token_url", "http://sts.example.com/token"), "token_url: \"http://sts.example.com/token\" " + https, secretFromEnv},
		"no client secret":          {"https://gw.example.com", with("client_secret", ""), "client_secret is required", secretFromEnv},
		"no token url":              {"https://gw.example.com", with("token_url", ""), "token_url is required", secretFromEnv},
		"unknown option":            {"https://gw.example.com", with("scope", "read"), "unknown CSM options [scope]", secretFromEnv},
		"no scheme base url":        {"gw.example.com", ok, https, secretFromEnv},
		"secret in the file":        {"https://gw.example.com", ok, "client_secret must be one ${NAME} reference to the environment", nil},
		"secret with a newline":     {"https://gw.example.com", with("client_secret", "secret\n"), "client_secret has surrounding spaces or a control character", secretFromEnv},
		"client id with a space":    {"https://gw.example.com", with("client_id", " id"), "client_id has surrounding spaces or a control character", secretFromEnv},
		"client id with a newline":  {"https://gw.example.com", with("client_id", "id\r\n"), "client_id has surrounding spaces or a control character", secretFromEnv},
		"secret with a control tab": {"https://gw.example.com", with("client_secret", "se\tcret"), "client_secret has surrounding spaces or a control character", secretFromEnv},
	} {
		t.Run(name, func(t *testing.T) {
			t.Parallel()
			b := config.Backend{Type: CSMType, BaseURL: tc.base, Options: tc.options, EnvOptions: tc.inTheEnv}
			_, err := NewCSMProvider("csm", b, env)
			switch {
			case tc.wantErr == "" && err != nil:
				t.Errorf("err = %v", err)
			case tc.wantErr != "" && (err == nil || !strings.Contains(err.Error(), tc.wantErr)):
				t.Errorf("err = %v, want %q", err, tc.wantErr)
			}
		})
	}
}
