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

package telemetry

import (
	"errors"
	"io"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/wso2/wso2-cloud-status/backend/go/internal/aggregator"
	"github.com/wso2/wso2-cloud-status/backend/go/internal/domain"
)

func TestMetricsExposition(t *testing.T) {
	t.Parallel()
	m := New("1.2.3")
	m.ObserveRequest("GET /api/v1/summary", 200, 3*time.Millisecond)
	m.FetchDone("cloudservices/choreo", aggregator.KindComponents, 40*time.Millisecond, nil)
	m.FetchDone("cloudservices/choreo", aggregator.KindIncidents, 40*time.Millisecond, errors.New("boom"))
	m.Published(time.Unix(1_800_000_000, 0))

	rec := httptest.NewRecorder()
	m.Handler().ServeHTTP(rec, httptest.NewRequestWithContext(t.Context(), "GET", "/metrics", nil))
	body, _ := io.ReadAll(rec.Body)
	for _, want := range []string{
		`statusd_http_requests_total{code="200",route="GET /api/v1/summary"} 1`,
		`statusd_upstream_fetches_total{kind="components",result="success",source="cloudservices/choreo"} 1`,
		`statusd_upstream_fetches_total{kind="incidents",result="error",source="cloudservices/choreo"} 1`,
		`statusd_upstream_last_success_timestamp_seconds{kind="components",source="cloudservices/choreo"}`,
		`statusd_snapshot_published_timestamp_seconds 1.8e+09`,
		`statusd_build_info{goversion=`,
		`go_goroutines`,
	} {
		if !strings.Contains(string(body), want) {
			t.Errorf("metrics missing %q", want)
		}
	}
	if strings.Contains(string(body), `statusd_upstream_last_success_timestamp_seconds{kind="incidents"`) {
		t.Error("a failed fetch must not update the last-success gauge")
	}
}

func scrape(t *testing.T, m *Metrics) string {
	t.Helper()
	rec := httptest.NewRecorder()
	m.Handler().ServeHTTP(rec, httptest.NewRequestWithContext(t.Context(), "GET", "/metrics", nil))
	body, _ := io.ReadAll(rec.Body)
	return string(body)
}

// TestAlertedSeriesStartAtZero: an increase() or rate() over a series that
// appears at 1 is 0, so these exist from the start.
func TestAlertedSeriesStartAtZero(t *testing.T) {
	t.Parallel()
	body := scrape(t, New("1.2.3"))
	for _, want := range []string{
		`statusd_config_reloads_total{result="applied"} 0`,
		`statusd_config_reloads_total{result="failed"} 0`,
		`statusd_http_requests_total{code="503",route="shed"} 0`,
	} {
		if !strings.Contains(body, want) {
			t.Errorf("metrics missing %q", want)
		}
	}
}

func TestOriginLockGauge(t *testing.T) {
	t.Parallel()
	m := New("1.2.3")
	if body := scrape(t, m); !strings.Contains(body, "statusd_origin_lock_enabled 0") {
		t.Error("the origin lock must read off until it is reported on")
	}
	m.OriginLock(true)
	if body := scrape(t, m); !strings.Contains(body, "statusd_origin_lock_enabled 1") {
		t.Error("statusd_origin_lock_enabled must read 1 with the lock on")
	}
	m.OriginLock(false)
	if body := scrape(t, m); !strings.Contains(body, "statusd_origin_lock_enabled 0") {
		t.Error("statusd_origin_lock_enabled must read 0 with the lock off")
	}
}

func TestSourceSeriesFollowTheBinding(t *testing.T) {
	t.Parallel()
	m := New("1.2.3")
	bound := time.Unix(1_800_000_000, 0)
	m.SourceBound("cloudservices/choreo", map[aggregator.Kind]time.Time{
		aggregator.KindComponents: bound, aggregator.KindUptime: bound, aggregator.KindIncidents: bound,
	})
	// A changed source that keeps its components from the previous binding.
	m.SourceBound("cloudservices/moesif", map[aggregator.Kind]time.Time{
		aggregator.KindComponents: bound.Add(-10 * time.Minute), aggregator.KindUptime: bound, aggregator.KindIncidents: bound,
	})
	body := scrape(t, m)
	for _, kind := range aggregator.Kinds() {
		want := `statusd_upstream_last_success_timestamp_seconds{kind="` + string(kind) + `",source="cloudservices/choreo"} 1.8e+09`
		if !strings.Contains(body, want) {
			t.Errorf("a bound source's last success must start at its binding: missing %q", want)
		}
	}
	if want := `statusd_upstream_last_success_timestamp_seconds{kind="components",source="cloudservices/moesif"} 1.7999994e+09`; !strings.Contains(body, want) {
		t.Errorf("a rebound source's last success must keep its data's fetch time: missing %q", want)
	}

	m.FetchDone("cloudservices/choreo", aggregator.KindComponents, time.Millisecond, nil)
	m.FetchDone("cloudservices/choreo", aggregator.KindUptime, time.Millisecond, errors.New("boom"))
	m.SourceRemoved("cloudservices/choreo")
	body = scrape(t, m)
	if strings.Contains(body, `source="cloudservices/choreo"`) {
		t.Error("a removed source's series must go with it")
	}
	if !strings.Contains(body, `statusd_upstream_last_success_timestamp_seconds{kind="components",source="cloudservices/moesif"}`) {
		t.Error("removing one source must keep the others")
	}
}

// TestProductStatusIsOneHot: each product has one series per status, 1 for
// the published one; a removed product's series go.
func TestProductStatusIsOneHot(t *testing.T) {
	t.Parallel()
	m := New("1.2.3")
	if body := scrape(t, m); strings.Contains(body, "statusd_product_status{") {
		t.Fatal("no product published yet, but product series exist")
	}
	m.ProductStatus("moesif", domain.StatusOperational)
	m.ProductStatus("developer-platform", domain.StatusUnknown)
	m.ProductStatus("moesif", domain.StatusOutage)
	body := scrape(t, m)
	want := map[string]map[string]string{
		"moesif":             {"unknown": "0", "operational": "0", "maintenance": "0", "degraded": "0", "outage": "1"},
		"developer-platform": {"unknown": "1", "operational": "0", "maintenance": "0", "degraded": "0", "outage": "0"},
	}
	for product, statuses := range want {
		for status, value := range statuses {
			line := `statusd_product_status{product="` + product + `",status="` + status + `"} ` + value
			if !strings.Contains(body, line+"\n") {
				t.Errorf("metrics missing %q", line)
			}
		}
	}

	m.ProductRemoved("developer-platform")
	body = scrape(t, m)
	if strings.Contains(body, `product="developer-platform"`) || !strings.Contains(body, `statusd_product_status{product="moesif",status="outage"} 1`) {
		t.Errorf("after removing developer-platform:\n%s", body)
	}
}

// TestConfigFileValid: the file the service started with was valid, so the
// gauge starts at 1; it follows every report after that.
func TestConfigFileValid(t *testing.T) {
	t.Parallel()
	m := New("1.2.3")
	for _, step := range []struct {
		report *bool
		want   string
	}{
		{nil, "statusd_config_file_valid 1\n"},
		{new(false), "statusd_config_file_valid 0\n"},
		{new(true), "statusd_config_file_valid 1\n"},
	} {
		if step.report != nil {
			m.ConfigFileValid(*step.report)
		}
		if body := scrape(t, m); !strings.Contains(body, step.want) {
			t.Fatalf("metrics missing %q", step.want)
		}
	}
}

// TestDataSeries: product completeness, the product-to-source join and the
// region-key counts follow the reports; a removed product or source loses
// its series.
func TestDataSeries(t *testing.T) {
	t.Parallel()
	m := New("1.2.3")
	m.ProductData("developer-platform", false, []string{"cloudservices/choreo", "cloudservices/choreo-eu"})
	m.ProductData("moesif", true, []string{"cloudservices/moesif"})
	m.SourceRegionKeys("cloudservices/choreo-eu", 1, 2)
	m.SourceRegionKeys("cloudservices/moesif", 0, 0)
	body := scrape(t, m)
	for _, want := range []string{
		`statusd_product_data_complete{product="developer-platform"} 0`,
		`statusd_product_data_complete{product="moesif"} 1`,
		`statusd_product_source_info{product="developer-platform",source="cloudservices/choreo"} 1`,
		`statusd_product_source_info{product="developer-platform",source="cloudservices/choreo-eu"} 1`,
		`statusd_source_region_keys{source="cloudservices/choreo-eu",state="missing"} 1`,
		`statusd_source_region_keys{source="cloudservices/choreo-eu",state="unmatched"} 2`,
		`statusd_source_region_keys{source="cloudservices/moesif",state="missing"} 0`,
	} {
		if !strings.Contains(body, want+"\n") {
			t.Errorf("metrics missing %q", want)
		}
	}

	m.ProductData("developer-platform", true, []string{"cloudservices/choreo"})
	m.ProductRemoved("moesif")
	m.SourceRemoved("cloudservices/choreo-eu")
	body = scrape(t, m)
	if !strings.Contains(body, `statusd_product_data_complete{product="developer-platform"} 1`) ||
		strings.Contains(body, `source="cloudservices/choreo-eu"`) || strings.Contains(body, `product="moesif"`) {
		t.Errorf("after the changes and removals:\n%s", body)
	}
}
