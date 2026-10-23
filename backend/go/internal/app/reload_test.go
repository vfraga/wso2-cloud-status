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
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/wso2/wso2-cloud-status/backend/go/internal/aggregator"
	"github.com/wso2/wso2-cloud-status/backend/go/internal/config"
)

type reloadCounter struct{ applied, failed chan struct{} }

func (r reloadCounter) ConfigReloaded(result string) {
	if result == reloadApplied {
		r.applied <- struct{}{}
	} else {
		r.failed <- struct{}{}
	}
}

func (reloadCounter) ConfigFileValid(bool) {}

// validity records every ConfigFileValid report.
type validity struct {
	mu      sync.Mutex
	reports []bool
}

func (v *validity) ConfigReloaded(string) {}

func (v *validity) ConfigFileValid(valid bool) {
	v.mu.Lock()
	defer v.mu.Unlock()
	v.reports = append(v.reports, valid)
}

// await waits until at least n reports have arrived after the first from,
// all equal to want, and returns the new count.
func (v *validity) await(t *testing.T, from, n int, want bool) int {
	t.Helper()
	for deadline := time.Now().Add(10 * time.Second); time.Now().Before(deadline); time.Sleep(20 * time.Millisecond) {
		v.mu.Lock()
		got := slices.Clone(v.reports[min(from, len(v.reports)):])
		v.mu.Unlock()
		for i, r := range got {
			if r != want {
				t.Fatalf("report %d after %d = %v, want %v", i, from, r, want)
			}
		}
		if len(got) >= n {
			return from + len(got)
		}
	}
	t.Fatalf("fewer than %d reports of %v after %d", n, want, from)
	return 0
}

// TestConfigFileValidityIsCheckedEveryTick: an invalid file shows as invalid
// on every watch tick until it is fixed, not only at the reload that
// rejected it; a deleted file is invalid too. A change a tick finds is
// logged.
func TestConfigFileValidityIsCheckedEveryTick(t *testing.T) {
	t.Parallel()
	path := filepath.Join(t.TempDir(), "statusd.yaml")
	text := configText(t, upstream(t).URL)
	if err := os.WriteFile(path, []byte(text), 0o600); err != nil {
		t.Fatal(err)
	}
	cfg, err := config.Load(path)
	if err != nil {
		t.Fatal(err)
	}
	var logs lockedBuffer
	a, err := New(cfg, slog.New(slog.NewTextHandler(&logs, nil)), "test")
	if err != nil {
		t.Fatal(err)
	}
	seen := &validity{}
	a.reloadObs = seen
	a.EnableReload(path, nil)
	ctx, cancel := context.WithCancel(t.Context())
	done := make(chan struct{})
	go func() {
		a.watchConfig(ctx)
		close(done)
	}()
	t.Cleanup(func() {
		cancel()
		<-done
	})

	n := seen.await(t, 0, 1, true)
	if err := os.WriteFile(path, []byte(text+"histroy: {}\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	// The reload that rejects it, then at least one tick with the file
	// unchanged.
	n = seen.await(t, n, 2, false)
	if err := os.WriteFile(path, []byte(text), 0o600); err != nil {
		t.Fatal(err)
	}
	n = seen.await(t, n, 1, true)
	if err := os.Remove(path); err != nil {
		t.Fatal(err)
	}
	n = seen.await(t, n, 1, false)
	if err := os.WriteFile(path, []byte(text), 0o600); err != nil {
		t.Fatal(err)
	}
	seen.await(t, n, 1, true)
	if out := logs.String(); !strings.Contains(out, "a restart would fail with it") || !strings.Contains(out, "valid again") {
		t.Fatalf("the changes found by a tick must be logged:\n%s", out)
	}
}

// configText is the shipped configuration pointed at the fixture upstream,
// on ephemeral ports, watched every second.
func configText(t *testing.T, upstreamURL string) string {
	t.Helper()
	raw, err := os.ReadFile("../../../../config/statusd.yaml")
	if err != nil {
		t.Fatal(err)
	}
	s := regexp.MustCompile(`base_url: .*`).ReplaceAllString(string(raw), "base_url: "+upstreamURL)
	s = regexp.MustCompile(`(?m)^  addr: .*$`).ReplaceAllString(s, `  addr: "127.0.0.1:0"`)
	s = regexp.MustCompile(`(?m)^  admin_addr: .*$`).ReplaceAllString(s, `  admin_addr: "127.0.0.1:0"`)
	return regexp.MustCompile(`watch_interval: .*`).ReplaceAllString(s, "watch_interval: 1s")
}

func productIDs(t *testing.T, base string) []string {
	t.Helper()
	_, body := get(t, base+"/api/v1/summary")
	var s aggregator.Summary
	if err := json.Unmarshal(body, &s); err != nil {
		t.Fatal(err)
	}
	ids := make([]string, 0, len(s.Products))
	for _, p := range s.Products {
		ids = append(ids, p.ID)
	}
	return ids
}

func waitFor(t *testing.T, ch <-chan struct{}, what string) {
	t.Helper()
	select {
	case <-ch:
	case <-time.After(10 * time.Second):
		t.Fatalf("timed out waiting for %s", what)
	}
}

func TestReloadFromFileAndSignal(t *testing.T) {
	t.Parallel()
	path := filepath.Join(t.TempDir(), "statusd.yaml")
	text := configText(t, upstream(t).URL)
	if err := os.WriteFile(path, []byte(text), 0o600); err != nil {
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
	counter := reloadCounter{applied: make(chan struct{}, 4), failed: make(chan struct{}, 4)}
	a.reloadObs = counter
	hup := make(chan os.Signal, 1)
	a.EnableReload(path, hup)
	if err := a.Listen(t.Context()); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(t.Context())
	defer cancel()
	go func() { _ = a.Run(ctx) }()
	base := "http://" + a.Addr().String()
	waitReady(t, "http://"+a.AdminAddr().String()+"/readyz")
	n := len(cfg.Products)
	last, before := cfg.Products[n-1].ID, cfg.Products[n-2].ID
	if got := productIDs(t, base); len(got) != n {
		t.Fatalf("products at start = %v, want %d", got, n)
	}

	// 1. Removing a product (the last one) from the file takes effect without a restart.
	cut := strings.Index(text, "  - id: "+last+"\n")
	if cut < 0 {
		t.Fatalf("the shipped config has no product %s to remove", last)
	}
	withoutLast := text[:cut]
	if err := os.WriteFile(path, []byte(withoutLast), 0o600); err != nil {
		t.Fatal(err)
	}
	waitFor(t, counter.applied, "the file change to apply")
	if got := productIDs(t, base); len(got) != n-1 || got[len(got)-1] != before {
		t.Fatalf("products after removing %s = %v", last, got)
	}
	if code, _ := get(t, base+"/api/v1/products/"+last); code != http.StatusNotFound {
		t.Fatalf("removed product still served: %d", code)
	}

	// 2. An invalid file is rejected and the running configuration stays.
	if err := os.WriteFile(path, []byte(withoutLast+"histroy: {}\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	waitFor(t, counter.failed, "the invalid file to be rejected")
	if got := productIDs(t, base); len(got) != n-1 {
		t.Fatalf("an invalid file changed the catalogue: %v", got)
	}

	// 3. SIGHUP reloads at once; restart-only settings are kept, not applied.
	if err := os.WriteFile(path, []byte(strings.Replace(text, `addr: "127.0.0.1:0"`, `addr: "127.0.0.1:1"`, 1)), 0o600); err != nil {
		t.Fatal(err)
	}
	hup <- os.Interrupt
	waitFor(t, counter.applied, "the signal reload")
	if got := productIDs(t, base); len(got) != n {
		t.Fatalf("products after SIGHUP = %v", got)
	}
	if a.cfg.Server.Addr != "127.0.0.1:0" {
		t.Fatalf("server.addr changed at runtime to %q; it must wait for a restart", a.cfg.Server.Addr)
	}
}

// TestReloadKeepsTheLastSuccessOfKeptData: a reload that changes a backend
// keeps its sources' data until they answer again, so
// statusd_upstream_last_success_timestamp_seconds keeps that data's fetch
// time instead of jumping to the reload, and StatusdUpstreamFailing does
// not resolve while the page still shows the old data.
func TestReloadKeepsTheLastSuccessOfKeptData(t *testing.T) {
	t.Parallel()
	path := filepath.Join(t.TempDir(), "statusd.yaml")
	text := configText(t, upstream(t).URL)
	if err := os.WriteFile(path, []byte(text), 0o600); err != nil {
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
	const series = `statusd_upstream_last_success_timestamp_seconds{kind="components",source="asgardeo/asgardeo"} `
	lastSuccess := func() float64 {
		t.Helper()
		rec := httptest.NewRecorder()
		a.admin.Handler.ServeHTTP(rec, httptest.NewRequestWithContext(t.Context(), http.MethodGet, "/metrics", nil))
		for line := range strings.Lines(rec.Body.String()) {
			if value, ok := strings.CutPrefix(strings.TrimSpace(line), series); ok {
				f, err := strconv.ParseFloat(value, 64)
				if err != nil {
					t.Fatal(err)
				}
				return f
			}
		}
		t.Fatalf("metrics lack %s", series)
		return 0
	}
	fetched := lastSuccess()

	// The asgardeo backend now points at an address that refuses: a changed
	// definition whose first fetch fails.
	at := strings.Index(text, "  asgardeo:\n")
	if at < 0 {
		t.Fatal("the shipped config has no asgardeo backend")
	}
	changed := text[:at] + strings.Replace(text[at:], "base_url: "+cfg.Backends["asgardeo"].BaseURL, "base_url: http://127.0.0.1:1", 1)
	if err := os.WriteFile(path, []byte(changed), 0o600); err != nil {
		t.Fatal(err)
	}
	reloaded := float64(time.Now().UnixNano()) / 1e9
	if err := a.Reload(t.Context()); err != nil {
		t.Fatal(err)
	}
	if a.cfg.Backends["asgardeo"].BaseURL != "http://127.0.0.1:1" {
		t.Fatalf("the reload did not change the asgardeo backend: %q", a.cfg.Backends["asgardeo"].BaseURL)
	}
	if got := lastSuccess(); got >= reloaded || got < fetched-1 {
		t.Fatalf("last success after the reload = %f, want the earlier fetch (%f), before the reload (%f)", got, fetched, reloaded)
	}
}

func TestReloadKeepsThePortOverride(t *testing.T) {
	t.Parallel()
	path := filepath.Join(t.TempDir(), "statusd.yaml")
	if err := os.WriteFile(path, []byte(configText(t, upstream(t).URL)), 0o600); err != nil {
		t.Fatal(err)
	}
	getenv := func(name string) string {
		if name == "PORT" {
			return "18299"
		}
		return ""
	}
	cfg, err := config.Load(path)
	if err != nil {
		t.Fatal(err)
	}
	if err := cfg.ApplyEnvOverrides(getenv); err != nil {
		t.Fatal(err)
	}
	var logs strings.Builder
	a, err := New(cfg, slog.New(slog.NewTextHandler(&logs, nil)), "test")
	if err != nil {
		t.Fatal(err)
	}
	a.getenv = getenv
	a.EnableReload(path, nil)
	if err := a.Reload(t.Context()); err != nil {
		t.Fatal(err)
	}
	if a.cfg.Server.Addr != ":18299" || strings.Contains(logs.String(), "restart only") {
		t.Fatalf("addr %q after reload; logs:\n%s", a.cfg.Server.Addr, logs.String())
	}
}

// TestReloadDuringShutdown stops the service while a reload is in flight: the
// watcher replaces the configuration as Run shuts the servers down. Run it
// with -race.
func TestReloadDuringShutdown(t *testing.T) {
	t.Parallel()
	asked := make(chan struct{}, 1)
	slow := httptest.NewServer(http.HandlerFunc(func(_ http.ResponseWriter, r *http.Request) {
		select {
		case asked <- struct{}{}:
		default:
		}
		<-r.Context().Done()
	}))
	t.Cleanup(slow.Close)
	path := filepath.Join(t.TempDir(), "statusd.yaml")
	text := configText(t, upstream(t).URL)
	if err := os.WriteFile(path, []byte(text), 0o600); err != nil {
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
	hup := make(chan os.Signal, 1)
	a.EnableReload(path, hup)
	if err := a.Listen(t.Context()); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(t.Context())
	stopped := make(chan error, 1)
	go func() { stopped <- a.Run(ctx) }()
	waitReady(t, "http://"+a.AdminAddr().String()+"/readyz")

	// A new product on a backend that never answers holds the reload in
	// its first poll until shutdown cancels it.
	withSlow := strings.Replace(text, "backends:\n", "backends:\n  slow:\n    base_url: "+slow.URL+"\n", 1) +
		"  - id: slow\n    name: Slow\n    page_url: https://slow.test\n    sources:\n      - backend: slow\n        cloud: slow\n" +
		"        regions: [{ key: us, id: us, name: US }]\n"
	if err := os.WriteFile(path, []byte(withSlow), 0o600); err != nil {
		t.Fatal(err)
	}
	hup <- os.Interrupt
	waitFor(t, asked, "the reload to poll the new source")
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

func TestReloadWithoutPathIsAnError(t *testing.T) {
	t.Parallel()
	a, err := New(shippedConfig(t, "http://127.0.0.1:1"), slog.New(slog.DiscardHandler), "test")
	if err != nil {
		t.Fatal(err)
	}
	if err := a.Reload(t.Context()); err == nil {
		t.Fatal("expected an error when reload is not enabled")
	}
}

func TestUnknownBackendTypeFailsStartup(t *testing.T) {
	t.Parallel()
	cfg := shippedConfig(t, "http://127.0.0.1:1")
	b := cfg.Backends["asgardeo"]
	b.Type = "csm"
	cfg.Backends["asgardeo"] = b
	if _, err := New(cfg, slog.New(slog.DiscardHandler), "test"); err == nil || !strings.Contains(err.Error(), `unknown type "csm"`) {
		t.Fatalf("err = %v", err)
	}
}

func TestFingerprintChangesWithEveryDefiningField(t *testing.T) {
	t.Parallel()
	base := config.Backend{Type: "t", BaseURL: "https://a", Timezone: "UTC", Options: map[string]string{"k": "v"}}
	ref := fingerprint(base, "c")
	variants := []config.Backend{
		{Type: "u", BaseURL: "https://a", Timezone: "UTC", Options: map[string]string{"k": "v"}},
		{Type: "t", BaseURL: "https://b", Timezone: "UTC", Options: map[string]string{"k": "v"}},
		{Type: "t", BaseURL: "https://a", Timezone: "Asia/Colombo", Options: map[string]string{"k": "v"}},
		{Type: "t", BaseURL: "https://a", Timezone: "UTC", Options: map[string]string{"k": "w"}},
	}
	for i, v := range variants {
		if fingerprint(v, "c") == ref {
			t.Errorf("variant %d has the same fingerprint", i)
		}
	}
	if fingerprint(base, "d") == ref || fingerprint(base, "c") != ref {
		t.Error("cloud must change the fingerprint; identical input must not")
	}
}
