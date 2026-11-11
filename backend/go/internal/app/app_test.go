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
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/wso2/wso2-cloud-status/backend/go/internal/aggregator"
	"github.com/wso2/wso2-cloud-status/backend/go/internal/config"
	"github.com/wso2/wso2-cloud-status/backend/go/internal/config/configtest"
	"github.com/wso2/wso2-cloud-status/backend/go/internal/domain"
	"github.com/wso2/wso2-cloud-status/backend/go/internal/testutil"
)

// upstream replays the captured responses of the real status API, for every
// cloud and both backends.
func upstream(t *testing.T) *httptest.Server {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		name := r.URL.Query().Get("cloud") + "." + strings.TrimPrefix(r.URL.Path, "/api/v1/") + ".json"
		body, err := os.ReadFile(testutil.RepoPath("testdata", "upstream", filepath.Base(name)))
		if err != nil {
			http.NotFound(w, r)
			return
		}
		_, _ = w.Write(body)
	}))
	t.Cleanup(srv.Close)
	return srv
}

func shippedConfig(t *testing.T, upstreamURL string) *config.Config {
	t.Helper()
	cfg := configtest.Load(t, testutil.RepoPath("config", "statusd.yaml"))
	for name, b := range cfg.Backends {
		b.BaseURL = upstreamURL
		cfg.Backends[name] = b
	}
	cfg.Server.Addr, cfg.Server.AdminAddr = "127.0.0.1:0", "127.0.0.1:0"
	return cfg
}

func get(t *testing.T, url string) (int, []byte) {
	t.Helper()
	req, err := http.NewRequestWithContext(t.Context(), http.MethodGet, url, nil)
	if err != nil {
		t.Fatal(err)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = resp.Body.Close() }()
	body, _ := io.ReadAll(resp.Body)
	return resp.StatusCode, body
}

// TestServiceEndToEnd runs the real wiring (config, legacy adapter,
// aggregator, HTTP servers, metrics) against replayed upstream data.
func TestServiceEndToEnd(t *testing.T) {
	t.Parallel()
	cfg := shippedConfig(t, upstream(t).URL)
	a, err := New(cfg, slog.New(slog.DiscardHandler), "test")
	if err != nil {
		t.Fatal(err)
	}
	if err := a.Listen(t.Context()); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	stopped := make(chan error, 1)
	go func() { stopped <- a.Run(ctx) }()
	base, admin := "http://"+a.Addr().String(), "http://"+a.AdminAddr().String()

	waitReady(t, admin+"/readyz")

	code, body := get(t, base+"/api/v1/summary")
	if code != http.StatusOK {
		t.Fatalf("summary: %d", code)
	}
	var summary aggregator.Summary
	if err := json.Unmarshal(body, &summary); err != nil {
		t.Fatal(err)
	}
	if summary.GeneratedAt.IsZero() {
		t.Fatalf("summary generated_at is zero: %s", body)
	}
	assertSummary(t, summary, cfg)

	if code, _ := get(t, base+"/api/v1/products/developer-platform"); code != http.StatusOK {
		t.Fatalf("product detail: %d", code)
	}
	if code, _ := get(t, base+"/metrics"); code != http.StatusNotFound {
		t.Fatalf("metrics must not be served publicly; got %d", code)
	}
	if _, body := get(t, admin+"/metrics"); !strings.Contains(string(body), `statusd_upstream_fetches_total{kind="components",result="success",source="cloudservices/choreo"}`) {
		t.Fatal("admin metrics missing upstream fetch counters")
	}

	cancel()
	select {
	case err := <-stopped:
		if err != nil {
			t.Fatalf("Run: %v", err)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("Run did not stop")
	}
}

// TestReadyWhileEveryUpstreamIsDown: with no upstream answering, the
// service is ready after its first poll round and serves every product as
// unknown, so a restart during an upstream outage, when the page is needed
// most, does not take it out of rotation.
func TestReadyWhileEveryUpstreamIsDown(t *testing.T) {
	t.Parallel()
	down := httptest.NewServer(http.NotFoundHandler())
	down.Close()
	cfg := shippedConfig(t, down.URL)
	a, err := New(cfg, slog.New(slog.DiscardHandler), "test")
	if err != nil {
		t.Fatal(err)
	}
	if err := a.Listen(t.Context()); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	stopped := make(chan error, 1)
	go func() { stopped <- a.Run(ctx) }()
	defer func() {
		cancel()
		if err := <-stopped; err != nil {
			t.Errorf("Run: %v", err)
		}
	}()
	waitReady(t, "http://"+a.AdminAddr().String()+"/readyz")
	_, body := get(t, "http://"+a.Addr().String()+"/api/v1/summary")
	var summary aggregator.Summary
	if err := json.Unmarshal(body, &summary); err != nil {
		t.Fatal(err)
	}
	if summary.Status != domain.StatusUnknown || summary.DataComplete || len(summary.Products) != len(cfg.Products) {
		t.Fatalf("summary %v, data_complete %v, %d products; want every configured product, unknown", summary.Status, summary.DataComplete, len(summary.Products))
	}
	for _, p := range summary.Products {
		if p.Status != domain.StatusUnknown {
			t.Errorf("%s is %v, want unknown", p.ID, p.Status)
		}
	}
}

func waitReady(t *testing.T, url string) {
	t.Helper()
	deadline := time.Now().Add(10 * time.Second)
	for time.Now().Before(deadline) {
		req, _ := http.NewRequestWithContext(t.Context(), http.MethodGet, url, nil)
		if resp, err := http.DefaultClient.Do(req); err == nil {
			_ = resp.Body.Close()
			if resp.StatusCode == http.StatusOK {
				return
			}
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatal("service never became ready")
}

// assertSummary: every configured product, with every configured region,
// known, complete and operational, as the captured fixtures are.
func assertSummary(t *testing.T, s aggregator.Summary, cfg *config.Config) {
	t.Helper()
	regions := map[string]int{}
	for _, p := range cfg.Products {
		for _, ref := range p.Sources {
			regions[p.ID] += len(ref.Regions)
		}
	}
	if len(s.Products) != len(regions) || s.Status != domain.StatusOperational {
		t.Fatalf("summary status %v with %d products", s.Status, len(s.Products))
	}
	for _, p := range s.Products {
		if len(p.Regions) != regions[p.ID] || !p.DataComplete || p.Outdated || p.Status != domain.StatusOperational {
			t.Errorf("%s: %d regions (want %d), complete=%v, outdated=%v, status=%v", p.ID, len(p.Regions), regions[p.ID], p.DataComplete, p.Outdated, p.Status)
		}
	}
}

// TestServerLimits: both listeners bound slow and oversized requests, the
// limits edge-and-abuse.md describes.
func TestServerLimits(t *testing.T) {
	t.Parallel()
	a, err := New(shippedConfig(t, "http://127.0.0.1:1"), slog.New(slog.DiscardHandler), "test")
	if err != nil {
		t.Fatal(err)
	}
	for name, srv := range map[string]*http.Server{"public": a.public, "admin": a.admin} {
		if srv.ReadHeaderTimeout != 5*time.Second || srv.ReadTimeout != 10*time.Second ||
			srv.WriteTimeout != 10*time.Second || srv.IdleTimeout != time.Minute || srv.MaxHeaderBytes != 128<<10 {
			t.Errorf("%s server: header %s, read %s, write %s, idle %s, max header %d bytes", name,
				srv.ReadHeaderTimeout, srv.ReadTimeout, srv.WriteTimeout, srv.IdleTimeout, srv.MaxHeaderBytes)
		}
	}
}

// TestEdgeSizedRequestReachesTheHandler: a request head as large as Front
// Door forwards gets statusd's own answer, with Cache-Control, rather than
// net/http's 431, which has none.
func TestEdgeSizedRequestReachesTheHandler(t *testing.T) {
	t.Parallel()
	a, err := New(shippedConfig(t, "http://127.0.0.1:1"), slog.New(slog.DiscardHandler), "test")
	if err != nil {
		t.Fatal(err)
	}
	ts := httptest.NewUnstartedServer(nil)
	ts.Config = a.public
	ts.Start()
	t.Cleanup(ts.Close)

	req, err := http.NewRequestWithContext(t.Context(), http.MethodGet, ts.URL+"/"+strings.Repeat("a", 8<<10), nil)
	if err != nil {
		t.Fatal(err)
	}
	for i := range 64 { // 64 header lines of 1 KB each
		req.Header.Set(fmt.Sprintf("X-Pad-%02d", i), strings.Repeat("a", 1024-len("X-Pad-00: \r\n")))
	}
	resp, err := ts.Client().Do(req)
	if err != nil {
		t.Fatal(err)
	}
	_ = resp.Body.Close()
	if resp.StatusCode == http.StatusRequestHeaderFieldsTooLarge || resp.Header.Get("Cache-Control") == "" {
		t.Fatalf("answered %d with Cache-Control %q, want statusd's own answer", resp.StatusCode, resp.Header.Get("Cache-Control"))
	}
}

func TestRunFailsWhenThePortIsTaken(t *testing.T) {
	t.Parallel()
	cfg := shippedConfig(t, "http://127.0.0.1:1")
	first, err := New(cfg, slog.New(slog.DiscardHandler), "test")
	if err != nil {
		t.Fatal(err)
	}
	if err := first.Listen(t.Context()); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = first.publicLn.Close(); _ = first.adminLn.Close() })
	cfg2 := *cfg
	cfg2.Server.Addr = first.Addr().String()
	second, err := New(&cfg2, slog.New(slog.DiscardHandler), "test")
	if err != nil {
		t.Fatal(err)
	}
	if err := second.Run(context.Background()); err == nil {
		t.Fatal("expected a listen error")
	}
	cfg3 := *cfg
	cfg3.Server.AdminAddr = first.AdminAddr().String()
	third, err := New(&cfg3, slog.New(slog.DiscardHandler), "test")
	if err != nil {
		t.Fatal(err)
	}
	if err := third.Listen(t.Context()); err == nil {
		t.Fatal("expected an admin listen error")
	}
}

// TestOriginLockIsVisible: the startup log says whether the origin lock is
// on, naming the required headers but never their values, and the admin
// port exports it as statusd_origin_lock_enabled.
func TestOriginLockIsVisible(t *testing.T) {
	t.Parallel()
	for _, tc := range []struct {
		headers map[string]string
		log     []string
		gauge   string
	}{
		{nil, []string{`"level":"ERROR"`, `"msg":"origin lock off: the public port answers requests that did not come through the CDN"`}, "statusd_origin_lock_enabled 0"},
		{map[string]string{"X-Azure-FDID": "secret-id"}, []string{`"level":"INFO"`, `"msg":"origin lock on","headers":["X-Azure-FDID"]`}, "statusd_origin_lock_enabled 1"},
	} {
		cfg := shippedConfig(t, "http://127.0.0.1:1")
		cfg.Server.RequiredHeaders = tc.headers
		var logs lockedBuffer
		a, err := New(cfg, slog.New(slog.NewJSONHandler(&logs, nil)), "test")
		if err != nil {
			t.Fatal(err)
		}
		if err := a.Listen(t.Context()); err != nil {
			t.Fatal(err)
		}
		ctx, cancel := context.WithCancel(context.Background())
		stopped := make(chan error, 1)
		go func() { stopped <- a.Run(ctx) }()
		_, metrics := get(t, "http://"+a.AdminAddr().String()+"/metrics")
		cancel()
		if err := <-stopped; err != nil {
			t.Fatalf("Run: %v", err)
		}
		lines := logs.String()
		for _, want := range tc.log {
			if !strings.Contains(lines, want) {
				t.Errorf("headers %v: log lacks %s:\n%s", tc.headers, want, lines)
			}
		}
		if strings.Contains(lines, "secret-id") {
			t.Errorf("the log must never carry a required header's value:\n%s", lines)
		}
		if !strings.Contains(string(metrics), tc.gauge) {
			t.Errorf("headers %v: metrics lack %q", tc.headers, tc.gauge)
		}
	}
}

func TestNewRejectsBadBackends(t *testing.T) {
	t.Parallel()
	cfg := shippedConfig(t, "http://127.0.0.1:1")
	b := cfg.Backends["asgardeo"]
	b.Timezone = "Nowhere/Nope"
	cfg.Backends["asgardeo"] = b
	if _, err := New(cfg, slog.New(slog.DiscardHandler), "test"); err == nil {
		t.Fatal("expected a timezone error")
	}
	cfg = shippedConfig(t, "ftp://bad")
	if _, err := New(cfg, slog.New(slog.DiscardHandler), "test"); err == nil {
		t.Fatal("expected a base URL error")
	}
}

func TestParseLevel(t *testing.T) {
	t.Parallel()
	for in, want := range map[string]slog.Level{"": slog.LevelInfo, "debug": slog.LevelDebug, "WARN": slog.LevelWarn} {
		if got, err := ParseLevel(in); err != nil || got != want {
			t.Fatalf("ParseLevel(%q) = %v, %v", in, got, err)
		}
	}
	if _, err := ParseLevel("loud"); err == nil {
		t.Fatal("expected an error")
	}
}

// TestASecretInAnotherOptionIsNeverShown: a CSM backend's option that is
// not a credential cannot read the client secret, so a configuration that
// tries (by mistake or not) is refused with an error that names the place,
// never the value: the error reaches the log at start and on every reload.
func TestASecretInAnotherOptionIsNeverShown(t *testing.T) {
	const secret = "s3cr3t-in-the-wrong-option"
	t.Setenv("CSM_CLIENT_ID", "client")
	t.Setenv("CSM_CLIENT_SECRET", secret)
	file := filepath.Join(t.TempDir(), "statusd.yaml")
	cfg := `backends:
  csm:
    type: csm-cloud-status
    base_url: https://csm.example.com
    options:
      client_id: "${CSM_CLIENT_ID}"
      client_secret: "${CSM_CLIENT_SECRET}"
      token_url: "${CSM_CLIENT_SECRET}"
products:
  - id: p
    name: P
    sources:
      - backend: csm
        cloud: c
        regions:
          - { key: us, id: us, name: US }
`
	if err := os.WriteFile(file, []byte(cfg), 0o600); err != nil {
		t.Fatal(err)
	}
	_, _, err := Load(file, func(string) string { return "" })
	if err == nil || !strings.Contains(err.Error(), "backends.csm.options.token_url") {
		t.Fatalf("err = %v, want the reference in token_url refused", err)
	}
	if strings.Contains(err.Error(), secret) {
		t.Fatalf("the error shows the client secret: %v", err)
	}
}
