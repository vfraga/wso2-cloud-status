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

package app

import (
	"bytes"
	"context"
	"fmt"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"

	"github.com/wso2/wso2-cloud-status/backend/go/internal/config"
	"github.com/wso2/wso2-cloud-status/backend/go/internal/source"
)

// lockedBuffer collects log output from concurrent writers.
type lockedBuffer struct {
	mu  sync.Mutex
	buf bytes.Buffer
}

func (b *lockedBuffer) Write(p []byte) (int, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buf.Write(p)
}

func (b *lockedBuffer) String() string {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buf.String()
}

// TestUpstreamRedirectsAreRefused: an upstream that redirects (here to a
// server holding valid data) fails the fetch instead of being followed, and
// the failed-fetch log line names where the redirect pointed.
func TestUpstreamRedirectsAreRefused(t *testing.T) {
	t.Parallel()
	data := upstream(t)
	var followed atomic.Int64
	target := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		followed.Add(1)
		data.Config.Handler.ServeHTTP(w, r)
	}))
	t.Cleanup(target.Close)
	redirecting := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, target.URL+r.URL.RequestURI(), http.StatusFound)
	}))
	t.Cleanup(redirecting.Close)

	var logs lockedBuffer
	a, err := New(shippedConfig(t, redirecting.URL), slog.New(slog.NewJSONHandler(&logs, nil)), "test")
	if err != nil {
		t.Fatal(err)
	}
	a.agg.RefreshAll(context.Background())
	if n := followed.Load(); n != 0 {
		t.Fatalf("the redirect target received %d requests, want none", n)
	}
	out := logs.String()
	if !strings.Contains(out, "upstream fetch failed") || !strings.Contains(out, "redirect to "+target.URL+"/api/v1/monitors?cloud=moesif refused") {
		t.Fatalf("log does not name the refused redirect:\n%s", out)
	}
}

// TestRenamedRegionKeyIsVisible: every fetch succeeds, but the upstream
// renamed Asgardeo's "eu" region "europe". The service logs it, and the
// metrics show the product incomplete and the source's missing and
// unmatched keys.
func TestRenamedRegionKeyIsVisible(t *testing.T) {
	t.Parallel()
	data := upstream(t)
	renaming := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		rec := httptest.NewRecorder()
		data.Config.Handler.ServeHTTP(rec, r)
		body := rec.Body.Bytes()
		if r.URL.Path == "/api/v1/monitors" && r.URL.Query().Get("cloud") == "asgardeo" {
			body = bytes.Replace(body, []byte(`"eu":`), []byte(`"europe":`), 1)
		}
		w.WriteHeader(rec.Code)
		_, _ = w.Write(body)
	}))
	t.Cleanup(renaming.Close)

	var logs lockedBuffer
	a, err := New(shippedConfig(t, renaming.URL), slog.New(slog.NewJSONHandler(&logs, nil)), "test")
	if err != nil {
		t.Fatal(err)
	}
	a.agg.RefreshAll(context.Background())
	if out := logs.String(); !strings.Contains(out, `"msg":"upstream region keys differ from the configuration; check the region keys in the configuration","source":"asgardeo/asgardeo","missing":["eu"],"unmatched":["europe"]`) {
		t.Fatalf("no drift warning for asgardeo:\n%s", out)
	}
	rec := httptest.NewRecorder()
	a.admin.Handler.ServeHTTP(rec, httptest.NewRequestWithContext(t.Context(), http.MethodGet, "/metrics", nil))
	body := rec.Body.String()
	for _, want := range []string{
		`statusd_product_data_complete{product="identity-platform"} 0`,
		`statusd_product_data_complete{product="moesif"} 1`,
		`statusd_product_source_info{product="identity-platform",source="asgardeo/asgardeo"} 1`,
		`statusd_source_region_keys{source="asgardeo/asgardeo",state="missing"} 1`,
		`statusd_source_region_keys{source="asgardeo/asgardeo",state="unmatched"} 1`,
		`statusd_source_region_keys{source="cloudservices/moesif",state="missing"} 0`,
		`statusd_upstream_fetches_total{kind="components",result="success",source="asgardeo/asgardeo"} 1`,
	} {
		if !strings.Contains(body, want+"\n") {
			t.Errorf("metrics missing %q", want)
		}
	}
}

// csmFake is CSM's cloud-status API with its token endpoint: it serves the
// captured fixtures in CSM's envelope, counts tokens and reads, and answers
// 429 for the clouds it throttles.
type csmFake struct {
	*httptest.Server
	tokens    atomic.Int32
	reads     atomic.Int32
	mu        sync.Mutex
	throttled map[string]bool
}

func newCSMFake(t *testing.T) *csmFake {
	t.Helper()
	f := &csmFake{throttled: map[string]bool{}}
	mux := http.NewServeMux()
	mux.HandleFunc("POST /oauth2/token", func(w http.ResponseWriter, _ *http.Request) {
		_, _ = fmt.Fprintf(w, `{"access_token":"token-%d","token_type":"Bearer","expires_in":3600}`, f.tokens.Add(1))
	})
	mux.HandleFunc("GET /cloud-status/{kind}", func(w http.ResponseWriter, r *http.Request) {
		f.reads.Add(1)
		cloud := r.URL.Query().Get("cloud")
		f.mu.Lock()
		throttled := f.throttled[cloud]
		f.mu.Unlock()
		if throttled {
			w.Header().Set("Retry-After", "120")
			w.WriteHeader(http.StatusTooManyRequests)
			return
		}
		name := filepath.Base(cloud + "." + r.PathValue("kind") + ".json")
		data, err := os.ReadFile(filepath.Join("..", "..", "..", "..", "testdata", "upstream", name))
		if err != nil {
			http.NotFound(w, r)
			return
		}
		_, _ = fmt.Fprintf(w, `{"result":{"code":0,"message":"success","cloud":%q,"data":%s}}`, cloud, data)
	})
	f.Server = httptest.NewServer(mux)
	t.Cleanup(f.Close)
	return f
}

func (f *csmFake) throttle(cloud string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.throttled[cloud] = true
}

// csmConfig is a configuration with one CSM backend and one product per
// cloud.
func csmConfig(baseURL string, clouds ...string) string {
	var sb strings.Builder
	fmt.Fprintf(&sb, `server: { addr: "127.0.0.1:0", admin_addr: "127.0.0.1:0" }
reload: { watch_interval: 0s }
backends:
  csm:
    type: csm-cloud-status
    base_url: %s
    options: { token_url: "%s/oauth2/token", client_id: test, client_secret: "${STATUSD_TEST_CSM_SECRET}" }
products:
`, baseURL, baseURL)
	for _, cloud := range clouds {
		fmt.Fprintf(&sb, "  - { id: %s, name: %s, sources: [{ backend: csm, cloud: %s, regions: [{ key: x, id: x, name: X }] }] }\n",
			cloud, cloud, cloud)
	}
	return sb.String()
}

// TestReloadKeepsOneProviderPerBackend: a reload that adds a cloud to a CSM
// backend binds it to the backend's running provider, so the clouds bound
// before and after the reload share one token and one throttling circuit.
func TestReloadKeepsOneProviderPerBackend(t *testing.T) {
	t.Setenv("STATUSD_TEST_CSM_SECRET", "secret")
	f := newCSMFake(t)
	path := filepath.Join(t.TempDir(), "statusd.yaml")
	if err := os.WriteFile(path, []byte(csmConfig(f.URL, "moesif")), 0o600); err != nil {
		t.Fatal(err)
	}
	cfg, err := config.Load(path)
	if err != nil {
		t.Fatal(err)
	}
	a, err := New(cfg, slog.New(slog.DiscardHandler), "test")
	if err != nil {
		t.Fatal(err)
	}
	a.EnableReload(path, nil)
	a.agg.RefreshAll(t.Context())
	if err := os.WriteFile(path, []byte(csmConfig(f.URL, "moesif", "choreo")), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := a.Reload(t.Context()); err != nil {
		t.Fatal(err)
	}
	if n := f.tokens.Load(); n != 1 {
		t.Errorf("tokens requested = %d, want 1 for the one backend", n)
	}
	// A 429 to the cloud the reload added holds the cloud bound before it.
	f.throttle("choreo")
	a.agg.RefreshAll(t.Context())
	reads := f.reads.Load()
	a.agg.RefreshAll(t.Context())
	if n := f.reads.Load() - reads; n != 0 {
		t.Errorf("%d reads reached CSM while it asked the backend to wait, want 0", n)
	}
}

// TestProvidersAreKeptWhileTheirBackendIsUnchanged: buildBindings reuses a
// backend's provider while its type, base URL, time zone and options are
// unchanged, and a change to any of them gets a new provider.
func TestProvidersAreKeptWhileTheirBackendIsUnchanged(t *testing.T) {
	t.Parallel()
	reg := source.NewRegistry()
	reg.Register("fake", func(string, config.Backend, source.Env) (source.Provider, error) {
		return &fakeProvider{}, nil
	})
	reg.Register("other", func(string, config.Backend, source.Env) (source.Provider, error) {
		return &fakeProvider{}, nil
	})
	base := config.Backend{Type: "fake", BaseURL: "https://a.test", Timezone: "UTC", Options: map[string]string{"k": "v"}}
	cfg := &config.Config{
		Backends: map[string]config.Backend{"b": base},
		Products: []config.Product{{ID: "p", Sources: []config.SourceRef{{Backend: "b", Cloud: "c"}}}},
	}
	_, first, err := buildBindings(cfg, reg, source.Env{}, nil)
	if err != nil {
		t.Fatal(err)
	}
	cfg.Products[0].Sources = append(cfg.Products[0].Sources, config.SourceRef{Backend: "b", Cloud: "d"})
	_, same, err := buildBindings(cfg, reg, source.Env{}, first)
	if err != nil {
		t.Fatal(err)
	}
	if same["b"].provider != first["b"].provider {
		t.Error("a backend that did not change got a new provider")
	}
	for name, changed := range map[string]config.Backend{
		"type":     {Type: "other", BaseURL: base.BaseURL, Timezone: base.Timezone, Options: base.Options},
		"base URL": {Type: base.Type, BaseURL: "https://b.test", Timezone: base.Timezone, Options: base.Options},
		"timezone": {Type: base.Type, BaseURL: base.BaseURL, Timezone: "Asia/Colombo", Options: base.Options},
		"options":  {Type: base.Type, BaseURL: base.BaseURL, Timezone: base.Timezone, Options: map[string]string{"k": "w"}},
	} {
		next := *cfg
		next.Backends = map[string]config.Backend{"b": changed}
		_, got, err := buildBindings(&next, reg, source.Env{}, first)
		if err != nil {
			t.Fatal(err)
		}
		if got["b"].provider == first["b"].provider {
			t.Errorf("a backend with a changed %s kept its provider", name)
		}
	}
}

// fakeProvider has a field so that two of them never share an address.
type fakeProvider struct{ _ byte }

func (*fakeProvider) Source(string) source.Source { return nil }
