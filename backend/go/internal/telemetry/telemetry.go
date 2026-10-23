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

// Package telemetry exposes Prometheus metrics for the service.
package telemetry

import (
	"maps"
	"net/http"
	"runtime"
	"strconv"
	"sync"
	"time"

	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/collectors"
	"github.com/prometheus/client_golang/prometheus/promhttp"

	"github.com/wso2/wso2-cloud-status/backend/go/internal/aggregator"
	"github.com/wso2/wso2-cloud-status/backend/go/internal/domain"
)

// Label names.
const (
	labelRoute   = "route"
	labelCode    = "code"
	labelSource  = "source"
	labelKind    = "kind"
	labelResult  = "result"
	labelProduct = "product"
	labelStatus  = "status"
	labelState   = "state"
)

var (
	_ aggregator.Observer        = (*Metrics)(nil)
	_ aggregator.SourceObserver  = (*Metrics)(nil)
	_ aggregator.ProductObserver = (*Metrics)(nil)
	_ aggregator.DataObserver    = (*Metrics)(nil)
)

// Metrics implements aggregator.Observer and httpapi.RequestObserver on a
// private registry, so tests and multiple instances never share state.
type Metrics struct {
	registry      *prometheus.Registry
	requests      *prometheus.CounterVec
	requestTime   *prometheus.HistogramVec
	fetches       *prometheus.CounterVec
	fetchTime     *prometheus.HistogramVec
	lastSuccess   *prometheus.GaugeVec
	lastPublished prometheus.Gauge
	reloads       *prometheus.CounterVec
	lastReload    prometheus.Gauge
	configValid   prometheus.Gauge
	originLock    prometheus.Gauge
	products      *productStatuses
	dataComplete  *prometheus.GaugeVec
	productSource *prometheus.GaugeVec
	regionKeys    *prometheus.GaugeVec
	// productMu serializes the product series updates with their removal.
	productMu sync.Mutex
}

// New registers every metric, plus Go runtime and process collectors.
func New(version string) *Metrics {
	m := &Metrics{
		registry: prometheus.NewRegistry(),
		requests: prometheus.NewCounterVec(prometheus.CounterOpts{
			Name: "statusd_http_requests_total", Help: "HTTP requests by matched route and status code.",
		}, []string{labelRoute, labelCode}),
		requestTime: prometheus.NewHistogramVec(prometheus.HistogramOpts{
			Name: "statusd_http_request_duration_seconds", Help: "HTTP request latency by matched route.",
			Buckets: []float64{0.0005, 0.001, 0.0025, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1},
		}, []string{labelRoute}),
		fetches: prometheus.NewCounterVec(prometheus.CounterOpts{
			Name: "statusd_upstream_fetches_total", Help: "Upstream fetches by source, kind and result.",
		}, []string{labelSource, labelKind, labelResult}),
		fetchTime: prometheus.NewHistogramVec(prometheus.HistogramOpts{
			Name: "statusd_upstream_fetch_duration_seconds", Help: "Upstream fetch latency by source and kind.",
			Buckets: prometheus.DefBuckets,
		}, []string{labelSource, labelKind}),
		lastSuccess: prometheus.NewGaugeVec(prometheus.GaugeOpts{
			Name: "statusd_upstream_last_success_timestamp_seconds", Help: "Unix time of the last successful fetch.",
		}, []string{labelSource, labelKind}),
		lastPublished: prometheus.NewGauge(prometheus.GaugeOpts{
			Name: "statusd_snapshot_published_timestamp_seconds", Help: "Unix time of the last published snapshot.",
		}),
	}
	m.reloads = prometheus.NewCounterVec(prometheus.CounterOpts{
		Name: "statusd_config_reloads_total", Help: "Configuration reloads by result (applied, failed).",
	}, []string{labelResult})
	m.lastReload = prometheus.NewGauge(prometheus.GaugeOpts{
		Name: "statusd_config_last_applied_timestamp_seconds", Help: "Unix time the running configuration was applied.",
	})
	m.lastReload.SetToCurrentTime()
	// The service started with its configuration file, so the file was
	// valid then; the watcher re-checks it on every tick.
	m.configValid = prometheus.NewGauge(prometheus.GaugeOpts{
		Name: "statusd_config_file_valid",
		Help: "1 when the configuration file on disk would start the service, 0 when a restart would fail with it.",
	})
	m.configValid.Set(1)
	m.originLock = prometheus.NewGauge(prometheus.GaugeOpts{
		Name: "statusd_origin_lock_enabled",
		Help: "1 when the public port answers only requests that carry the CDN's headers (server.required_headers), 0 when it answers anyone.",
	})
	m.products = &productStatuses{
		desc: prometheus.NewDesc("statusd_product_status",
			"Published status of each product: 1 for the status the page shows, 0 for the others.",
			[]string{labelProduct, labelStatus}, nil),
		status: map[string]domain.Status{},
	}
	m.dataComplete = prometheus.NewGaugeVec(prometheus.GaugeOpts{
		Name: "statusd_product_data_complete",
		Help: "1 when every region and component status the page shows for the product is known, 0 when some read unknown.",
	}, []string{labelProduct})
	m.productSource = prometheus.NewGaugeVec(prometheus.GaugeOpts{
		Name: "statusd_product_source_info",
		Help: "1 for every source a product reads; joins product series with source series.",
	}, []string{labelProduct, labelSource})
	m.regionKeys = prometheus.NewGaugeVec(prometheus.GaugeOpts{
		Name: "statusd_source_region_keys",
		Help: "Region keys that differ between a source's last answer and the configuration: missing (configured, not reported) or unmatched (reported, not configured).",
	}, []string{labelSource, labelState})
	info := prometheus.NewGauge(prometheus.GaugeOpts{
		Name: "statusd_build_info", Help: "Build information; always 1.",
		ConstLabels: prometheus.Labels{"version": version, "goversion": runtime.Version()},
	})
	info.Set(1)
	m.registry.MustRegister(m.requests, m.requestTime, m.fetches, m.fetchTime, m.lastSuccess, m.lastPublished,
		m.reloads, m.lastReload, m.configValid, m.originLock, m.products, m.dataComplete, m.productSource, m.regionKeys, info,
		collectors.NewGoCollector(), collectors.NewProcessCollector(collectors.ProcessCollectorOpts{}))
	// Series the alerts take an increase or a rate of exist from the start, at
	// 0: a counter that first appears at 1 shows no increase, so the first
	// failed reload or shed request would never alert.
	m.reloads.WithLabelValues("applied")
	m.reloads.WithLabelValues("failed")
	m.requests.WithLabelValues("shed", strconv.Itoa(http.StatusServiceUnavailable))
	return m
}

// Handler serves the metrics in the Prometheus exposition format.
func (m *Metrics) Handler() http.Handler {
	return promhttp.HandlerFor(m.registry, promhttp.HandlerOpts{Registry: m.registry})
}

// ObserveRequest implements httpapi.RequestObserver.
func (m *Metrics) ObserveRequest(route string, code int, took time.Duration) {
	m.requests.WithLabelValues(route, strconv.Itoa(code)).Inc()
	m.requestTime.WithLabelValues(route).Observe(took.Seconds())
}

// FetchDone implements aggregator.Observer.
func (m *Metrics) FetchDone(source string, kind aggregator.Kind, took time.Duration, err error) {
	result := "success"
	if err != nil {
		result = "error"
	} else {
		m.lastSuccess.WithLabelValues(source, string(kind)).SetToCurrentTime()
	}
	m.fetches.WithLabelValues(source, string(kind), result).Inc()
	m.fetchTime.WithLabelValues(source, string(kind)).Observe(took.Seconds())
}

// SourceBound implements aggregator.SourceObserver. A new source's
// last-success series start at the time it was bound, so a source that
// never answers alerts like one that stopped answering; a changed source's
// keep the fetch time of the data it still serves.
func (m *Metrics) SourceBound(source string, lastSuccess map[aggregator.Kind]time.Time) {
	for kind, at := range lastSuccess {
		m.lastSuccess.WithLabelValues(source, string(kind)).Set(float64(at.UnixNano()) / 1e9)
	}
}

// SourceRemoved implements aggregator.SourceObserver. A removed source's
// series go with it, so it cannot alert after it is gone.
func (m *Metrics) SourceRemoved(source string) {
	labels := prometheus.Labels{labelSource: source}
	m.fetches.DeletePartialMatch(labels)
	m.fetchTime.DeletePartialMatch(labels)
	m.lastSuccess.DeletePartialMatch(labels)
	m.regionKeys.DeletePartialMatch(labels)
}

// Published implements aggregator.Observer.
func (m *Metrics) Published(at time.Time) {
	m.lastPublished.Set(float64(at.UnixNano()) / 1e9)
}

// ConfigReloaded implements app.ReloadObserver.
func (m *Metrics) ConfigReloaded(result string) {
	m.reloads.WithLabelValues(result).Inc()
	if result == "applied" {
		m.lastReload.SetToCurrentTime()
	}
}

// ConfigFileValid implements app.ReloadObserver.
func (m *Metrics) ConfigFileValid(valid bool) {
	if valid {
		m.configValid.Set(1)
		return
	}
	m.configValid.Set(0)
}

// OriginLock records whether the origin lock is on. It is a server setting,
// so it changes only with a restart.
func (m *Metrics) OriginLock(enabled bool) {
	if enabled {
		m.originLock.Set(1)
		return
	}
	m.originLock.Set(0)
}

// ProductStatus implements aggregator.ProductObserver.
func (m *Metrics) ProductStatus(product string, status domain.Status) {
	m.products.mu.Lock()
	defer m.products.mu.Unlock()
	m.products.status[product] = status
}

// ProductRemoved implements aggregator.ProductObserver. A removed product's
// series go with it.
func (m *Metrics) ProductRemoved(product string) {
	m.products.mu.Lock()
	delete(m.products.status, product)
	m.products.mu.Unlock()
	m.productMu.Lock()
	defer m.productMu.Unlock()
	labels := prometheus.Labels{labelProduct: product}
	m.dataComplete.DeletePartialMatch(labels)
	m.productSource.DeletePartialMatch(labels)
}

// ProductData implements aggregator.DataObserver.
func (m *Metrics) ProductData(product string, complete bool, sources []string) {
	m.productMu.Lock()
	defer m.productMu.Unlock()
	value := 0.0
	if complete {
		value = 1
	}
	m.dataComplete.WithLabelValues(product).Set(value)
	m.productSource.DeletePartialMatch(prometheus.Labels{labelProduct: product})
	for _, source := range sources {
		m.productSource.WithLabelValues(product, source).Set(1)
	}
}

// SourceRegionKeys implements aggregator.DataObserver.
func (m *Metrics) SourceRegionKeys(source string, missing, unmatched int) {
	m.regionKeys.WithLabelValues(source, "missing").Set(float64(missing))
	m.regionKeys.WithLabelValues(source, "unmatched").Set(float64(unmatched))
}

// productStatuses exposes statusd_product_status: for each product, one
// series per status, 1 for the published status and 0 for the others. It is
// a collector, not a GaugeVec, so a scrape never sees a product between two
// statuses (no 1, or two).
type productStatuses struct {
	desc   *prometheus.Desc
	mu     sync.Mutex
	status map[string]domain.Status
}

func (p *productStatuses) Describe(ch chan<- *prometheus.Desc) { ch <- p.desc }

func (p *productStatuses) Collect(ch chan<- prometheus.Metric) {
	p.mu.Lock()
	current := maps.Clone(p.status)
	p.mu.Unlock()
	for product, published := range current {
		for _, s := range domain.Statuses() {
			value := 0.0
			if s == published {
				value = 1
			}
			ch <- prometheus.MustNewConstMetric(p.desc, prometheus.GaugeValue, value, product, s.String())
		}
	}
}
