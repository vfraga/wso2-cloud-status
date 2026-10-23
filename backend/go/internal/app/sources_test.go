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
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
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
