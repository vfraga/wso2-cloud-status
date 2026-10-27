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
		Type:    CSMType,
		BaseURL: f.URL,
		Options: map[string]string{"token_url": f.URL + "/oauth2/token", "client_id": "status-page", "client_secret": "s3cret"},
	}
}

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
		"86400": maxRetryAfter,
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
	release  chan struct{} // when set, each answer waits for it
}

func newIssuer(t *testing.T) *issuer {
	t.Helper()
	is := &issuer{}
	is.Server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		n := is.requests.Add(1)
		if is.release != nil {
			<-is.release
		}
		if is.failing.Load() {
			http.Error(w, "down", http.StatusServiceUnavailable)
			return
		}
		_, _ = fmt.Fprintf(w, `{"access_token":"token-%d","token_type":"Bearer","expires_in":1000}`, n)
	}))
	t.Cleanup(is.Close)
	return is
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
	clock := time.Date(2026, 10, 27, 12, 0, 0, 0, time.UTC)
	ts := is.source(t, func() time.Time { return clock })
	ctx := context.Background()
	get := func(want string) {
		t.Helper()
		got, err := ts.token(ctx)
		if err != nil || got != want {
			t.Fatalf("token() = %q, %v; want %q", got, err, want)
		}
	}
	get("token-1")
	clock = clock.Add(400 * time.Second) // before half its life: cached
	get("token-1")
	clock = clock.Add(200 * time.Second) // past half: a new one
	get("token-2")
	if n := is.requests.Load(); n != 2 {
		t.Fatalf("requests = %d, want 2", n)
	}
	// The issuer goes down: the cached token serves until it expires, and
	// the issuer is asked again only after the retry wait.
	is.failing.Store(true)
	clock = clock.Add(600 * time.Second)
	get("token-2")
	get("token-2")
	if n := is.requests.Load(); n != 3 {
		t.Errorf("requests = %d, want 3 (one failed request, then the wait)", n)
	}
	clock = clock.Add(500 * time.Second) // token-2 has expired
	if _, err := ts.token(ctx); !errors.Is(err, ErrToken) {
		t.Errorf("after expiry: err = %v, want ErrToken", err)
	}
	is.failing.Store(false)
	clock = clock.Add(tokenRetry)
	get("token-5")
}

func TestTokenIsAskedForOnceAtATime(t *testing.T) {
	t.Parallel()
	is := newIssuer(t)
	is.release = make(chan struct{})
	ts := is.source(t, time.Now)
	var wg sync.WaitGroup
	got := make([]string, 10)
	for i := range got {
		wg.Go(func() {
			got[i], _ = ts.token(context.Background())
		})
	}
	time.Sleep(50 * time.Millisecond)
	close(is.release)
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
	if _, err := src.Components(context.Background()); !errors.Is(err, ErrUnexpectedStatus) {
		t.Fatalf("401: err = %v", err)
	}
	if _, err := src.Components(context.Background()); err != nil {
		t.Fatalf("after 401: %v", err)
	}
	if n := f.tokens.Load(); n != 2 {
		t.Errorf("tokens issued = %d, want 2", n)
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
	}}
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
	for name, tc := range map[string]struct {
		base    string
		options map[string]string
		wantErr string
	}{
		"https":              {"https://gw.example.com/csm/v1.0", ok, ""},
		"loopback http":      {"http://127.0.0.1:18090", with("token_url", "http://localhost:18090/oauth2/token"), ""},
		"plain http":         {"http://gw.example.com", ok, "must be https"},
		"plain http token":   {"https://gw.example.com", with("token_url", "http://sts.example.com/token"), "must be https"},
		"no client secret":   {"https://gw.example.com", with("client_secret", ""), "client_secret is required"},
		"no token url":       {"https://gw.example.com", with("token_url", ""), "token_url is required"},
		"unknown option":     {"https://gw.example.com", with("scope", "read"), "unknown CSM options [scope]"},
		"no scheme base url": {"gw.example.com", ok, "must be https"},
	} {
		t.Run(name, func(t *testing.T) {
			t.Parallel()
			_, err := NewCSMProvider("csm", config.Backend{Type: CSMType, BaseURL: tc.base, Options: tc.options}, env)
			switch {
			case tc.wantErr == "" && err != nil:
				t.Errorf("err = %v", err)
			case tc.wantErr != "" && (err == nil || !strings.Contains(err.Error(), tc.wantErr)):
				t.Errorf("err = %v, want %q", err, tc.wantErr)
			}
		})
	}
}
