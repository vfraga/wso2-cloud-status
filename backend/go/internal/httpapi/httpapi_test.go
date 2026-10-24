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

package httpapi

import (
	"bytes"
	"compress/gzip"
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"slices"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/wso2/wso2-cloud-status/backend/go/internal/aggregator"
	"github.com/wso2/wso2-cloud-status/backend/go/internal/config"
	"github.com/wso2/wso2-cloud-status/backend/go/internal/domain"
	"github.com/wso2/wso2-cloud-status/backend/go/internal/source"
)

var checked = time.Date(2026, 10, 20, 12, 0, 0, 0, time.UTC)

func sampleBuild() aggregator.Built {
	p := aggregator.ProductDetail{ProductSummary: aggregator.ProductSummary{ID: "api-platform", Name: "API Platform", Status: domain.StatusOperational}}
	return aggregator.Built{
		Summary:  aggregator.Summary{Status: domain.StatusOperational, Products: []aggregator.ProductSummary{p.ProductSummary}},
		Products: map[string]aggregator.ProductDetail{"api-platform": p},
		Ready:    true,
	}
}

type observed struct {
	mu     sync.Mutex
	routes []string
}

func (o *observed) ObserveRequest(route string, _ int, _ time.Duration) {
	o.mu.Lock()
	defer o.mu.Unlock()
	o.routes = append(o.routes, route)
}

func newTestHandler(t *testing.T, publish bool) (http.Handler, *Store, *observed) {
	t.Helper()
	store := &Store{}
	if publish {
		if err := store.Publish(sampleBuild()); err != nil {
			t.Fatal(err)
		}
	}
	obs := &observed{}
	h := NewHandler(Options{Store: store, CacheControl: "public, max-age=10", AllowedOrigins: []string{"*"}, Observer: obs})
	return h, store, obs
}

func do(h http.Handler, method, target string, headers map[string]string) *httptest.ResponseRecorder {
	req := httptest.NewRequestWithContext(context.Background(), method, target, nil)
	for k, v := range headers {
		req.Header.Set(k, v)
	}
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	return rec
}

func TestSummaryResponse(t *testing.T) {
	t.Parallel()
	h, _, obs := newTestHandler(t, true)
	rec := do(h, http.MethodGet, "/api/v1/summary", nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("code = %d", rec.Code)
	}
	var body aggregator.Summary
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil || body.Status != domain.StatusOperational || len(body.Products) != 1 {
		t.Fatalf("body = %s, err %v", rec.Body, err)
	}
	for header, want := range map[string]string{
		"Content-Type":           "application/json",
		"Cache-Control":          "public, max-age=10",
		"X-Content-Type-Options": "nosniff",
		"Vary":                   "Accept-Encoding",
	} {
		if got := rec.Header().Get(header); got != want {
			t.Errorf("%s = %q, want %q", header, got, want)
		}
	}
	if rec.Header().Get("ETag") == "" || rec.Header().Get("X-Request-ID") == "" {
		t.Fatalf("missing ETag or X-Request-ID: %v", rec.Header())
	}
	if len(obs.routes) != 1 || obs.routes[0] != "GET /api/v1/summary" {
		t.Fatalf("observed routes = %v, want the matched pattern", obs.routes)
	}
}

func TestConditionalRequests(t *testing.T) {
	t.Parallel()
	h, _, _ := newTestHandler(t, true)
	etag := do(h, http.MethodGet, "/api/v1/summary", nil).Header().Get("ETag")
	for _, inm := range []string{etag, "W/" + etag, `"other", ` + etag, "*"} {
		if rec := do(h, http.MethodGet, "/api/v1/summary", map[string]string{"If-None-Match": inm}); rec.Code != http.StatusNotModified || rec.Body.Len() != 0 {
			t.Fatalf("If-None-Match %q: code %d body %d", inm, rec.Code, rec.Body.Len())
		}
	}
	if rec := do(h, http.MethodGet, "/api/v1/summary", map[string]string{"If-None-Match": `"stale"`}); rec.Code != http.StatusOK {
		t.Fatalf("mismatched etag: code %d", rec.Code)
	}
}

func TestGzip(t *testing.T) {
	t.Parallel()
	h, _, _ := newTestHandler(t, true)
	plain := do(h, http.MethodGet, "/api/v1/summary", nil).Body.Bytes()
	rec := do(h, http.MethodGet, "/api/v1/summary", map[string]string{"Accept-Encoding": "br, gzip;q=0.8"})
	if rec.Header().Get("Content-Encoding") != "gzip" {
		t.Fatalf("Content-Encoding = %q", rec.Header().Get("Content-Encoding"))
	}
	zr, err := gzip.NewReader(rec.Body)
	if err != nil {
		t.Fatal(err)
	}
	unzipped, _ := io.ReadAll(zr)
	if !bytes.Equal(unzipped, plain) {
		t.Fatal("gzip body differs from the plain body")
	}

	// Each representation has its own strong ETag, and If-None-Match matches
	// only the selected one's.
	plainTag := do(h, http.MethodGet, "/api/v1/summary", nil).Header().Get("ETag")
	gzipTag := rec.Header().Get("ETag")
	if plainTag == "" || gzipTag == plainTag || strings.HasPrefix(gzipTag, "W/") {
		t.Fatalf("plain ETag %s, gzip ETag %s: want two distinct strong tags", plainTag, gzipTag)
	}
	for _, c := range []struct {
		name, accept, inm, etag string
		code                    int
	}{
		{"gzip, its own tag", "gzip", gzipTag, gzipTag, http.StatusNotModified},
		{"gzip, the plain tag", "gzip", plainTag, gzipTag, http.StatusOK},
		{"plain, its own tag", "identity", plainTag, plainTag, http.StatusNotModified},
		{"plain, the gzip tag", "identity", gzipTag, plainTag, http.StatusOK},
	} {
		got := do(h, http.MethodGet, "/api/v1/summary", map[string]string{"Accept-Encoding": c.accept, "If-None-Match": c.inm})
		if got.Code != c.code || got.Header().Get("ETag") != c.etag {
			t.Errorf("%s: %d with ETag %s, want %d with %s", c.name, got.Code, got.Header().Get("ETag"), c.code, c.etag)
		}
	}
}

// acceptEncodingCases is the table the handler and the contract tests share.
func acceptEncodingCases(t *testing.T) []struct {
	Header string `json:"header"`
	Gzip   bool   `json:"gzip"`
} {
	t.Helper()
	raw, err := os.ReadFile("../../../../testdata/http/accept-encoding.json")
	if err != nil {
		t.Fatal(err)
	}
	var table struct {
		Cases []struct {
			Header string `json:"header"`
			Gzip   bool   `json:"gzip"`
		} `json:"cases"`
	}
	if err := json.Unmarshal(raw, &table); err != nil || len(table.Cases) == 0 {
		t.Fatalf("accept-encoding table: %v", err)
	}
	return table.Cases
}

func TestAcceptsGzip(t *testing.T) {
	t.Parallel()
	for _, c := range acceptEncodingCases(t) {
		if got := acceptsGzip(c.Header); got != c.Gzip {
			t.Errorf("acceptsGzip(%q) = %v, want %v", c.Header, got, c.Gzip)
		}
	}
}

// TestRepeatedHeaderLines: a list header sent as several lines reads as one
// value, the lines joined by commas (RFC 9110 section 5.3), not as its first
// line only.
func TestRepeatedHeaderLines(t *testing.T) {
	t.Parallel()
	h, _, _ := newTestHandler(t, true)
	etag := do(h, http.MethodGet, "/api/v1/summary", nil).Header().Get("ETag")
	tests := []struct {
		name   string
		header string
		lines  []string
		code   int
		gzip   bool
	}{
		{"gzip on the second Accept-Encoding line", "Accept-Encoding", []string{"br", "gzip"}, http.StatusOK, true},
		{"gzip refused on the second line", "Accept-Encoding", []string{"*", "gzip;q=0"}, http.StatusOK, false},
		{"an empty Accept-Encoding line adds nothing", "Accept-Encoding", []string{"", "gzip"}, http.StatusOK, true},
		{"the ETag on the second If-None-Match line", "If-None-Match", []string{`"other"`, etag}, http.StatusNotModified, false},
		{"no ETag on any If-None-Match line", "If-None-Match", []string{`"a"`, `"b"`}, http.StatusOK, false},
		{"empty If-None-Match lines are no condition", "If-None-Match", []string{"", " "}, http.StatusOK, false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			req := httptest.NewRequestWithContext(t.Context(), http.MethodGet, "/api/v1/summary", nil)
			for _, line := range tt.lines {
				req.Header.Add(tt.header, line)
			}
			rec := httptest.NewRecorder()
			h.ServeHTTP(rec, req)
			if gz := rec.Header().Get("Content-Encoding") == "gzip"; rec.Code != tt.code || gz != tt.gzip {
				t.Fatalf("%s %q: %d gzip=%v, want %d gzip=%v", tt.header, tt.lines, rec.Code, gz, tt.code, tt.gzip)
			}
		})
	}
}

func TestHeadHasNoBody(t *testing.T) {
	t.Parallel()
	h, _, _ := newTestHandler(t, true)
	rec := do(h, http.MethodHead, "/api/v1/summary", nil)
	if rec.Code != http.StatusOK || rec.Body.Len() != 0 || rec.Header().Get("Content-Length") == "" {
		t.Fatalf("HEAD: code %d body %d length %q", rec.Code, rec.Body.Len(), rec.Header().Get("Content-Length"))
	}
}

func TestProductRoutes(t *testing.T) {
	t.Parallel()
	h, _, obs := newTestHandler(t, true)
	if rec := do(h, http.MethodGet, "/api/v1/products/api-platform", nil); rec.Code != http.StatusOK {
		t.Fatalf("known product: %d", rec.Code)
	}
	rec := do(h, http.MethodGet, "/api/v1/products/nope", nil)
	if rec.Code != http.StatusNotFound || rec.Header().Get("Content-Type") != "application/problem+json" {
		t.Fatalf("unknown product: %d %s", rec.Code, rec.Header().Get("Content-Type"))
	}
	if obs.routes[1] != "GET /api/v1/products/{id}" {
		t.Fatalf("route label = %q, want the pattern, not the path", obs.routes[1])
	}
	if rec := do(h, http.MethodGet, "/api/v1/incidents", nil); rec.Code != http.StatusOK {
		t.Fatalf("incidents: %d", rec.Code)
	}
}

func TestNotFoundAndMethodNotAllowed(t *testing.T) {
	t.Parallel()
	h, _, obs := newTestHandler(t, true)
	if rec := do(h, http.MethodGet, "/wp-login.php", nil); rec.Code != http.StatusNotFound {
		t.Fatalf("unknown path: %d", rec.Code)
	}
	rec := do(h, http.MethodPost, "/api/v1/summary", nil)
	if rec.Code != http.StatusMethodNotAllowed || rec.Header().Get("Allow") != "GET, HEAD" {
		t.Fatalf("POST: %d Allow=%q", rec.Code, rec.Header().Get("Allow"))
	}
	var p map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &p); err != nil || p["status"] != float64(405) {
		t.Fatalf("problem body = %s", rec.Body)
	}
	if obs.routes[0] != "unmatched" {
		t.Fatalf("route label = %q, want unmatched", obs.routes[0])
	}
}

// TestEncodedPathsAreNotFound: a percent-encoded spelling of a path gets the
// cacheable 404 for unknown paths, not the canonical path's body.
func TestEncodedPathsAreNotFound(t *testing.T) {
	t.Parallel()
	store := &Store{}
	if err := store.Publish(sampleBuild()); err != nil {
		t.Fatal(err)
	}
	obs := &observed{}
	h := NewHandler(Options{Store: store, NotFoundCacheControl: "public, max-age=60", Observer: obs})
	for _, path := range []string{"/api/v1/%73ummary", "/api/v1/sum%6dary", "/api/v1/%69ncidents", "/api/v1/products/api%2Dplatform", "/%68ealthz"} {
		rec := do(h, http.MethodGet, path, nil)
		if rec.Code != http.StatusNotFound || rec.Header().Get("Cache-Control") != "public, max-age=60" ||
			rec.Header().Get("Content-Type") != "application/problem+json" {
			t.Errorf("GET %s: %d Cache-Control %q Content-Type %q, want the cacheable 404", path, rec.Code,
				rec.Header().Get("Cache-Control"), rec.Header().Get("Content-Type"))
		}
	}
	if rec := do(h, http.MethodGet, "/api/v1/summary", nil); rec.Code != http.StatusOK {
		t.Fatalf("the canonical path: %d, want 200", rec.Code)
	}
	if obs.routes[0] != "unmatched" {
		t.Fatalf("route label = %q, want unmatched", obs.routes[0])
	}
}

func TestWarmingUp(t *testing.T) {
	t.Parallel()
	h, _, _ := newTestHandler(t, false)
	if rec := do(h, http.MethodGet, "/api/v1/summary", nil); rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("summary before first build: %d", rec.Code)
	}
	if rec := do(h, http.MethodGet, "/readyz", nil); rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("readyz before first build: %d", rec.Code)
	}
	if rec := do(h, http.MethodGet, "/healthz", nil); rec.Code != http.StatusOK {
		t.Fatalf("healthz: %d", rec.Code)
	}
}

func TestReadyAndAdminHandler(t *testing.T) {
	t.Parallel()
	_, store, _ := newTestHandler(t, true)
	metrics := http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { _, _ = w.Write([]byte("m 1")) })
	admin := NewAdminHandler(store, metrics)
	if rec := do(admin, http.MethodGet, "/readyz", nil); rec.Code != http.StatusOK {
		t.Fatalf("readyz: %d", rec.Code)
	}
	if rec := do(admin, http.MethodGet, "/metrics", nil); rec.Body.String() != "m 1" {
		t.Fatalf("metrics: %q", rec.Body)
	}
	if rec := do(NewAdminHandler(store, nil), http.MethodGet, "/metrics", nil); rec.Code != http.StatusNotFound {
		t.Fatalf("metrics without a handler: %d", rec.Code)
	}
}

func TestCORS(t *testing.T) {
	t.Parallel()
	h, _, _ := newTestHandler(t, true)
	for _, origin := range []string{"https://status.cloud.wso2.com", ""} {
		rec := do(h, http.MethodGet, "/api/v1/summary", map[string]string{"Origin": origin})
		if rec.Header().Get("Access-Control-Allow-Origin") != "*" || strings.Contains(strings.Join(rec.Header().Values("Vary"), ","), "Origin") {
			t.Fatalf("origin %q: ACAO = %q, Vary = %v", origin, rec.Header().Get("Access-Control-Allow-Origin"), rec.Header().Values("Vary"))
		}
	}
	// A cross-origin page reads the server's clock and the time a cache held
	// the response.
	exposed := do(h, http.MethodGet, "/api/v1/summary", map[string]string{"Origin": "https://x.test"}).Header().Get("Access-Control-Expose-Headers")
	if exposed != "Date, Age, ETag, X-Request-ID" {
		t.Fatalf("Access-Control-Expose-Headers = %q", exposed)
	}
	pre := do(h, http.MethodOptions, "/api/v1/summary", map[string]string{"Origin": "https://x.test"})
	if pre.Code != http.StatusNoContent || !strings.Contains(pre.Header().Get("Access-Control-Allow-Methods"), "GET") {
		t.Fatalf("preflight: %d %v", pre.Code, pre.Header())
	}
	if got := pre.Header().Get("Access-Control-Allow-Headers"); got != "If-None-Match, If-Modified-Since, X-Request-ID" {
		t.Fatalf("preflight Allow-Headers = %q", got)
	}

	strict := NewHandler(Options{Store: &Store{}, AllowedOrigins: []string{"https://ok.test"}})
	if got := do(strict, http.MethodGet, "/healthz", map[string]string{"Origin": "https://ok.test"}).Header().Get("Access-Control-Allow-Origin"); got != "https://ok.test" {
		t.Fatalf("listed origin: ACAO = %q", got)
	}
	for _, origin := range []string{"https://evil.test", "", "https://ok.test"} {
		rec := do(strict, http.MethodGet, "/healthz", map[string]string{"Origin": origin})
		if got := rec.Header().Values("Vary"); len(got) != 1 || got[0] != "Origin" {
			t.Fatalf("origin %q: Vary = %v, want Origin once on every response", origin, got)
		}
		if origin != "https://ok.test" && rec.Header().Get("Access-Control-Allow-Origin") != "" {
			t.Fatalf("unlisted origin %q: ACAO = %q", origin, rec.Header().Get("Access-Control-Allow-Origin"))
		}
	}
}

func TestCORSHeadersOnRefusals(t *testing.T) {
	t.Parallel()
	h := NewHandler(Options{Store: &Store{}, AllowedOrigins: []string{"*"}, RequiredHeaders: map[string]string{"X-Azure-FDID": "id-1"}})
	if rec := do(h, http.MethodGet, "/api/v1/summary", nil); rec.Code != http.StatusForbidden || rec.Header().Get("Access-Control-Allow-Origin") != "*" {
		t.Fatalf("403: ACAO = %q", rec.Header().Get("Access-Control-Allow-Origin"))
	}
}

// TestSecurityHeadersOnEveryResponse: every answer of the public port carries
// the security headers, Strict-Transport-Security included, whatever its
// status: data, a 304, a probe, a 404 or 405, a warming-up 503, a preflight
// and the origin lock's 403.
func TestSecurityHeadersOnEveryResponse(t *testing.T) {
	t.Parallel()
	h, _, _ := newTestHandler(t, true)
	cold, _, _ := newTestHandler(t, false)
	locked := NewHandler(Options{Store: &Store{}, RequiredHeaders: map[string]string{"X-Azure-FDID": "id-1"}})
	etag := do(h, http.MethodGet, "/api/v1/summary", nil).Header().Get("ETag")
	for name, rec := range map[string]*httptest.ResponseRecorder{
		"200":       do(h, http.MethodGet, "/api/v1/summary", nil),
		"304":       do(h, http.MethodGet, "/api/v1/summary", map[string]string{"If-None-Match": etag}),
		"healthz":   do(h, http.MethodGet, "/healthz", nil),
		"404":       do(h, http.MethodGet, "/nope", nil),
		"405":       do(h, http.MethodPost, "/api/v1/summary", nil),
		"503":       do(cold, http.MethodGet, "/api/v1/summary", nil),
		"preflight": do(h, http.MethodOptions, "/api/v1/summary", nil),
		"403":       do(locked, http.MethodGet, "/api/v1/summary", nil),
	} {
		for header, want := range map[string]string{
			"Strict-Transport-Security": "max-age=31536000",
			"X-Content-Type-Options":    "nosniff",
			"Referrer-Policy":           "no-referrer",
		} {
			if got := rec.Header().Get(header); got != want {
				t.Errorf("%s (%d): %s = %q, want %q", name, rec.Code, header, got, want)
			}
		}
	}
}

func TestDefaultCacheControl(t *testing.T) {
	t.Parallel()
	h := NewHandler(Options{Store: &Store{}, NotFoundCacheControl: "public, max-age=60", AllowedOrigins: []string{"*"}})
	// ServeMux redirects unclean paths itself; the redirect must not reach
	// the CDN without a Cache-Control header.
	if rec := do(h, http.MethodGet, "/api//v1/summary", nil); rec.Code != http.StatusTemporaryRedirect || rec.Header().Get("Cache-Control") != "public, max-age=60" {
		t.Fatalf("redirect: %d Cache-Control = %q", rec.Code, rec.Header().Get("Cache-Control"))
	}
	if rec := do(h, http.MethodOptions, "/api/v1/summary", nil); rec.Code != http.StatusNoContent || rec.Header().Get("Cache-Control") != "public, max-age=60" {
		t.Fatalf("preflight: %d Cache-Control = %q", rec.Code, rec.Header().Get("Cache-Control"))
	}
	if got := do(h, http.MethodGet, "/healthz", nil).Header().Get("Cache-Control"); got != "no-store" {
		t.Fatalf("a handler's own Cache-Control must win, got %q", got)
	}
}

func TestRequestIDPropagation(t *testing.T) {
	t.Parallel()
	h, _, _ := newTestHandler(t, true)
	if got := do(h, http.MethodGet, "/healthz", map[string]string{"X-Request-ID": "abc-123"}).Header().Get("X-Request-ID"); got != "abc-123" {
		t.Fatalf("well-formed id: %q", got)
	}
	if got := do(h, http.MethodGet, "/healthz", map[string]string{"X-Request-ID": "bad id\n"}).Header().Get("X-Request-ID"); got == "bad id\n" || len(got) != 32 {
		t.Fatalf("malformed id must be replaced, got %q", got)
	}
}

func TestPanicBecomesProblem(t *testing.T) {
	t.Parallel()
	var logs bytes.Buffer
	h := chain(http.HandlerFunc(func(http.ResponseWriter, *http.Request) { panic("boom") }),
		recoverer(slog.New(slog.NewTextHandler(&logs, nil))), requestID)
	rec := do(h, http.MethodGet, "/", nil)
	if rec.Code != http.StatusInternalServerError || !strings.Contains(logs.String(), "boom") {
		t.Fatalf("code %d logs %q", rec.Code, logs.String())
	}
}

func TestAbortHandlerPanicIsRepanicked(t *testing.T) {
	t.Parallel()
	h := recoverer(slog.New(slog.DiscardHandler))(http.HandlerFunc(func(http.ResponseWriter, *http.Request) { panic(http.ErrAbortHandler) }))
	defer func() {
		if recover() != http.ErrAbortHandler { //nolint:errorlint // Identity comparison is the contract.
			t.Fatal("ErrAbortHandler must propagate")
		}
	}()
	do(h, http.MethodGet, "/", nil)
}

func TestServerErrorsAreLogged(t *testing.T) {
	t.Parallel()
	var logs bytes.Buffer
	h := accessLog(slog.New(slog.NewTextHandler(&logs, nil)), nopRequestObserver{})(
		http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusBadGateway) }))
	do(h, http.MethodGet, "/x", nil)
	if !strings.Contains(logs.String(), "status=502") {
		t.Fatalf("logs = %q", logs.String())
	}
	h = accessLog(slog.New(slog.NewTextHandler(&logs, nil)), nopRequestObserver{})(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {}))
	if rec := do(h, http.MethodGet, "/x", nil); rec.Code != http.StatusOK {
		t.Fatalf("implicit status: %d", rec.Code)
	}
}

func TestPublishIsAtomicUnderLoad(t *testing.T) {
	t.Parallel()
	h, store, _ := newTestHandler(t, true)
	var wg sync.WaitGroup
	for range 4 {
		wg.Go(func() {
			for range 200 {
				if rec := do(h, http.MethodGet, "/api/v1/summary", nil); rec.Code != http.StatusOK {
					t.Errorf("code %d during publish", rec.Code)
					return
				}
			}
		})
	}
	for range 200 {
		if err := store.Publish(sampleBuild()); err != nil {
			t.Error(err)
		}
	}
	wg.Wait()
}

func TestLastModifiedTracksContentNotPublishes(t *testing.T) {
	t.Parallel()
	now := time.Date(2026, 10, 20, 10, 0, 0, 0, time.UTC)
	store := &Store{Clock: func() time.Time { return now }}
	if err := store.Publish(sampleBuild()); err != nil {
		t.Fatal(err)
	}
	h := NewHandler(Options{Store: store})
	first := do(h, http.MethodGet, "/api/v1/summary", nil).Header().Get("Last-Modified")

	now = now.Add(time.Minute)
	if err := store.Publish(sampleBuild()); err != nil {
		t.Fatal(err)
	}
	if got := do(h, http.MethodGet, "/api/v1/summary", nil).Header().Get("Last-Modified"); got != first {
		t.Fatalf("unchanged content: Last-Modified moved from %s to %s", first, got)
	}
	changed := sampleBuild()
	changed.Summary.Status = domain.StatusDegraded
	if err := store.Publish(changed); err != nil {
		t.Fatal(err)
	}
	if got := do(h, http.MethodGet, "/api/v1/summary", nil).Header().Get("Last-Modified"); got != now.Format(http.TimeFormat) {
		t.Fatalf("changed content: Last-Modified = %s, want %s", got, now.Format(http.TimeFormat))
	}
}

// TestLastModifiedNeverAfterDate: every change of a body moves its time
// forward by at least a second, but a response never sends a Last-Modified
// later than its Date (RFC 9110 section 8.8.2.1); a capped value still
// revalidates to the newer body, and what is sent never goes backwards.
func TestLastModifiedNeverAfterDate(t *testing.T) {
	t.Parallel()
	base := time.Date(2026, 10, 20, 10, 0, 0, 0, time.UTC)
	now := base
	store := &Store{Clock: func() time.Time { return now }}
	h := NewHandler(Options{Store: store})
	get := func(ims string) *httptest.ResponseRecorder {
		t.Helper()
		rec := do(h, http.MethodGet, "/api/v1/summary", map[string]string{"If-Modified-Since": ims})
		date, err := http.ParseTime(rec.Header().Get("Date"))
		if err != nil || !date.Equal(now.Truncate(time.Second)) {
			t.Fatalf("Date = %q, want the clock %s", rec.Header().Get("Date"), now.Format(http.TimeFormat))
		}
		if lm, err := http.ParseTime(rec.Header().Get("Last-Modified")); err != nil || lm.After(date) {
			t.Fatalf("Last-Modified %q is later than Date %q", rec.Header().Get("Last-Modified"), rec.Header().Get("Date"))
		}
		return rec
	}
	steps := []struct {
		status domain.Status
		at     time.Duration
		sent   time.Duration
	}{
		{domain.StatusOperational, 200 * time.Millisecond, 0},
		// Two more changes within the same second: each is a second newer
		// inside, but what is sent stays at the Date.
		{domain.StatusDegraded, 700 * time.Millisecond, 0},
		{domain.StatusOutage, 900 * time.Millisecond, 0},
		// Unchanged content keeps its time, now behind the clock.
		{domain.StatusOutage, 5 * time.Second, 2 * time.Second},
		// Once the clock is ahead again, it wins.
		{domain.StatusDegraded, 6500 * time.Millisecond, 6 * time.Second},
	}
	var previous string
	for i, st := range steps {
		now = base.Add(st.at)
		b := sampleBuild()
		b.Summary.Status = st.status
		if err := store.Publish(b); err != nil {
			t.Fatal(err)
		}
		rec := get("")
		if got, want := rec.Header().Get("Last-Modified"), base.Add(st.sent).Format(http.TimeFormat); got != want {
			t.Fatalf("step %d: Last-Modified = %s, want %s", i, got, want)
		}
		// A copy revalidating with the previous Last-Modified gets the
		// newer body even when the value sent did not move.
		if i > 0 && st.status != steps[i-1].status {
			if again := get(previous); again.Code != http.StatusOK {
				t.Fatalf("step %d: If-Modified-Since %s = %d, want 200 with the changed body", i, previous, again.Code)
			}
		}
		previous = rec.Header().Get("Last-Modified")
	}
	if rec := get(previous); rec.Code != http.StatusNotModified {
		t.Fatalf("If-Modified-Since the current Last-Modified = %d, want 304", rec.Code)
	}
	other := do(h, http.MethodGet, "/api/v1/products/api-platform", nil).Header().Get("Last-Modified")
	if other != base.Format(http.TimeFormat) {
		t.Fatalf("an unchanged route keeps its own time, got %s", other)
	}
}

func TestIfModifiedSince(t *testing.T) {
	t.Parallel()
	h, _, _ := newTestHandler(t, true)
	lm := do(h, http.MethodGet, "/api/v1/summary", nil).Header().Get("Last-Modified")
	if rec := do(h, http.MethodGet, "/api/v1/summary", map[string]string{"If-Modified-Since": lm}); rec.Code != http.StatusNotModified {
		t.Fatalf("If-Modified-Since = Last-Modified: %d, want 304", rec.Code)
	}
	old := time.Date(2000, 1, 1, 0, 0, 0, 0, time.UTC).Format(http.TimeFormat)
	if rec := do(h, http.MethodGet, "/api/v1/summary", map[string]string{"If-Modified-Since": old}); rec.Code != http.StatusOK {
		t.Fatalf("older If-Modified-Since: %d, want 200", rec.Code)
	}
	both := map[string]string{"If-Modified-Since": lm, "If-None-Match": `"different"`}
	if rec := do(h, http.MethodGet, "/api/v1/summary", both); rec.Code != http.StatusOK {
		t.Fatalf("If-None-Match must take precedence: %d, want 200", rec.Code)
	}
}

func TestNotFoundIsCacheable(t *testing.T) {
	t.Parallel()
	h := NewHandler(Options{Store: &Store{}, NotFoundCacheControl: "public, max-age=60"})
	if got := do(h, http.MethodGet, "/random-path-123", nil).Header().Get("Cache-Control"); got != "public, max-age=60" {
		t.Fatalf("404 Cache-Control = %q", got)
	}
	if got := do(h, http.MethodPost, "/api/v1/summary", nil).Header().Get("Cache-Control"); got != "no-store" {
		t.Fatalf("405 Cache-Control = %q", got)
	}
	if got := do(NewHandler(Options{Store: &Store{}}), http.MethodGet, "/x", nil).Header().Get("Cache-Control"); got != "no-store" {
		t.Fatalf("unset NotFoundCacheControl must default to no-store, got %q", got)
	}
}

func TestShedBeyondMaxInFlight(t *testing.T) {
	t.Parallel()
	release := make(chan struct{})
	entered := make(chan struct{})
	obs := &observed{}
	var once sync.Once
	slow := http.HandlerFunc(func(_ http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/a" {
			once.Do(func() { close(entered) })
			<-release
		}
	})
	h := chain(slow, shed(1, obs))
	done := make(chan struct{})
	go func() {
		do(h, http.MethodGet, "/a", nil)
		close(done)
	}()
	<-entered
	rec := do(h, http.MethodGet, "/b", nil)
	// At the limit the platform's probes still get through.
	for _, probe := range []string{"/healthz", "/readyz"} {
		if got := do(h, http.MethodGet, probe, nil); got.Code != http.StatusOK {
			t.Errorf("%s at the limit: %d, want 200", probe, got.Code)
		}
	}
	close(release)
	<-done
	if rec.Code != http.StatusServiceUnavailable || rec.Header().Get("Retry-After") != "1" {
		t.Fatalf("over the limit: %d Retry-After=%q", rec.Code, rec.Header().Get("Retry-After"))
	}
	if len(obs.routes) != 1 || obs.routes[0] != "shed" {
		t.Fatalf("shed requests must be observed as route shed: %v", obs.routes)
	}
	if rec := do(h, http.MethodGet, "/c", map[string]string{}); rec.Code == http.StatusServiceUnavailable {
		t.Fatal("a slot must be released after the request completes")
	}
}

func TestOriginLock(t *testing.T) {
	t.Parallel()
	store := &Store{}
	if err := store.Publish(sampleBuild()); err != nil {
		t.Fatal(err)
	}
	h := NewHandler(Options{Store: store, RequiredHeaders: map[string]string{"X-Azure-FDID": "id-1"}})
	if rec := do(h, http.MethodGet, "/api/v1/summary", nil); rec.Code != http.StatusForbidden {
		t.Fatalf("without the header: %d, want 403", rec.Code)
	}
	if rec := do(h, http.MethodGet, "/api/v1/summary", map[string]string{"X-Azure-FDID": "id-2"}); rec.Code != http.StatusForbidden {
		t.Fatalf("wrong value: %d, want 403", rec.Code)
	}
	if rec := do(h, http.MethodGet, "/api/v1/summary", map[string]string{"X-Azure-FDID": "id-1"}); rec.Code != http.StatusOK {
		t.Fatalf("right value: %d, want 200", rec.Code)
	}
	if rec := do(h, http.MethodGet, "/readyz", nil); rec.Code != http.StatusOK {
		t.Fatalf("probes must stay open: %d", rec.Code)
	}
}

// staticSource answers every poll with the same healthy data.
type staticSource struct{}

func (staticSource) Components(context.Context) (source.Components, error) {
	return source.Components{"us": {{Name: "Core", Status: domain.StatusOperational, Components: []domain.Component{
		{Name: "API", Status: domain.StatusOperational},
	}}}}, nil
}

func (staticSource) Uptime(context.Context) (source.Uptime, error) { return source.Uptime{}, nil }

func (staticSource) Incidents(context.Context) (source.Incidents, error) {
	return source.Incidents{Items: []domain.Incident{}, CoverageStart: checked.AddDate(0, -6, 0)}, nil
}

// TestBodyChangesOncePerMinute: with nothing else changing, the body (and so
// its ETag and Last-Modified) changes when the minute of generated_at does,
// and only then. A cache that revalidates gets a 304 within the minute and a
// 200 at least once a minute.
func TestBodyChangesOncePerMinute(t *testing.T) {
	t.Parallel()
	now := checked.Add(10 * time.Second)
	clock := func() time.Time { return now }
	store := &Store{Clock: clock}
	cfg := &config.Config{
		Polling: config.Polling{
			ComponentsInterval: time.Hour, UptimeInterval: time.Hour, IncidentsInterval: time.Hour,
			RequestTimeout: time.Second, StaleAfter: 5 * time.Minute,
		},
		History: config.History{Days: 3},
		Products: []config.Product{{ID: "p", Name: "P", PageURL: "https://p.test", Sources: []config.SourceRef{
			{Backend: "b", Cloud: "c", Regions: []config.RegionRef{{Key: "us", ID: "us", Name: "US"}}},
		}}},
	}
	agg, err := aggregator.New(cfg, map[string]aggregator.Binding{"b/c": {Source: staticSource{}, Fingerprint: "v1"}},
		aggregator.Options{Clock: clock, Publish: store.Publish})
	if err != nil {
		t.Fatal(err)
	}
	agg.RefreshAll(context.Background())
	h := NewHandler(Options{Store: store})
	first := do(h, http.MethodGet, "/api/v1/summary", nil)
	etag := first.Header().Get("ETag")
	if !strings.Contains(first.Body.String(), `"generated_at":"2026-10-20T12:00:00Z"`) {
		t.Fatalf("first body = %s, want generated_at 12:00:00Z", first.Body)
	}

	now = checked.Add(59 * time.Second)
	agg.Rebuild()
	if rec := do(h, http.MethodGet, "/api/v1/summary", map[string]string{"If-None-Match": etag}); rec.Code != http.StatusNotModified {
		t.Fatalf("same minute: %d, want 304", rec.Code)
	}

	now = checked.Add(time.Minute)
	agg.Rebuild()
	for _, path := range []string{"/api/v1/summary", "/api/v1/products/p", "/api/v1/incidents"} {
		rec := do(h, http.MethodGet, path, map[string]string{"If-Modified-Since": first.Header().Get("Last-Modified")})
		if rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), `"generated_at":"2026-10-20T12:01:00Z"`) {
			t.Fatalf("GET %s in the next minute: %d %s, want 200 with generated_at 12:01:00Z", path, rec.Code, rec.Body)
		}
	}
	if rec := do(h, http.MethodGet, "/api/v1/summary", map[string]string{"If-None-Match": etag}); rec.Code != http.StatusOK || rec.Header().Get("ETag") == etag {
		t.Fatalf("next minute: %d with ETag %s, want 200 with a new ETag", rec.Code, rec.Header().Get("ETag"))
	}
}

// codes records each observed request's route label and status code.
type codes struct {
	mu   sync.Mutex
	seen []string
}

func (c *codes) ObserveRequest(route string, code int, _ time.Duration) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.seen = append(c.seen, route+" "+strconv.Itoa(code))
}

// TestProbeRouteLabels pins the route labels the alert rules depend on.
// StatusdServerErrors and StatusdClientErrors leave the probes out of both
// sides of their ratios by these exact labels, so a replica that is not
// ready (readyz 503) does not page; requests the origin lock refuses
// before routing count as "unmatched". The rules file must name the probe
// labels as observed, in both ratio alerts, numerator and denominator.
func TestProbeRouteLabels(t *testing.T) {
	t.Parallel()
	obs := &codes{}
	h := NewHandler(Options{Store: &Store{}, RequiredHeaders: map[string]string{"X-Azure-FDID": "id-1"}, Observer: obs})
	for _, path := range []string{"/readyz", "/healthz", "/api/v1/summary"} {
		do(h, http.MethodGet, path, nil)
	}
	want := []string{"GET /readyz 503", "GET /healthz 200", "unmatched 403"}
	if !slices.Equal(obs.seen, want) {
		t.Fatalf("observed %q, want %q", obs.seen, want)
	}
	rules, err := os.ReadFile("../../../../deploy/observability/prometheus-rules.yaml")
	if err != nil {
		t.Fatal(err)
	}
	probes := `route!~"GET /readyz|GET /healthz"`
	if n := strings.Count(string(rules), probes) + strings.Count(string(rules), `route!~"shed|GET /readyz|GET /healthz"`); n != 4 {
		t.Fatalf("prometheus-rules.yaml excludes the probe routes %d times, want 4 (both sides of StatusdServerErrors and StatusdClientErrors)", n)
	}
}
