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

package contract

import (
	"bytes"
	"compress/gzip"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"maps"
	"net/http"
	"os"
	"reflect"
	"slices"
	"strings"
	"testing"
	"time"

	"go.yaml.in/yaml/v3"
)

// Minimal views for semantic invariants; the schema checks cover the rest.
type region struct {
	ID       string   `json:"id"`
	Location string   `json:"location"`
	Name     string   `json:"name"`
	Status   string   `json:"status"`
	Uptime   []uptime `json:"uptime"`
}

type uptime struct {
	Window  string  `json:"window"`
	Percent float64 `json:"percent"`
}

type location struct {
	ID     string `json:"id"`
	Status string `json:"status"`
}

type incident struct {
	ID         string  `json:"id"`
	Title      string  `json:"title"`
	StartedAt  string  `json:"started_at"`
	ResolvedAt *string `json:"resolved_at"`
	Impact     string  `json:"impact"`
}

type day struct {
	Date        string         `json:"date"`
	Status      string         `json:"status"`
	Minutes     map[string]int `json:"minutes"`
	IncidentIDs []string       `json:"incident_ids"`
}

type regionDetail struct {
	ID       string   `json:"id"`
	Location string   `json:"location"`
	Name     string   `json:"name"`
	Status   string   `json:"status"`
	Uptime   []uptime `json:"uptime"`
	Groups   []struct {
		Components []struct {
			Name   string `json:"name"`
			Status string `json:"status"`
		} `json:"components"`
	} `json:"groups"`
}

// checkedAt is a product's last successful fetch per kind of data; nil is
// JSON null (never answered).
type checkedAt struct {
	Components *string `json:"components"`
	Incidents  *string `json:"incidents"`
	Uptime     *string `json:"uptime"`
}

type staleFlags struct {
	Components bool `json:"components"`
	Incidents  bool `json:"incidents"`
	Uptime     bool `json:"uptime"`
}

type product struct {
	ID              string         `json:"id"`
	Status          string         `json:"status"`
	AffectedRegions int            `json:"affected_regions"`
	DataComplete    bool           `json:"data_complete"`
	Outdated        bool           `json:"outdated"`
	CheckedAt       checkedAt      `json:"checked_at"`
	Stale           staleFlags     `json:"stale"`
	Locations       []location     `json:"locations"`
	Regions         []region       `json:"regions"`
	History         []day          `json:"history"`
	GeneratedAt     string         `json:"generated_at"`
	RegionDetails   []regionDetail `json:"region_details"`
	Incidents       []incident     `json:"incidents"`
}

type summary struct {
	Status          string     `json:"status"`
	DataComplete    bool       `json:"data_complete"`
	GeneratedAt     string     `json:"generated_at"`
	Products        []product  `json:"products"`
	ActiveIncidents []incident `json:"active_incidents"`
}

var severity = map[string]int{"unknown": 0, "operational": 1, "maintenance": 2, "degraded": 3, "outage": 4}

func worst(statuses ...string) string {
	out := "unknown"
	for _, s := range statuses {
		if severity[s] > severity[out] {
			out = s
		}
	}
	return out
}

// effectiveImpact is how an incident counts in roll-ups: an impact the
// service could not read counts as degraded.
func effectiveImpact(impact string) string {
	if impact == "unknown" {
		return "degraded"
	}
	return impact
}

var client = &http.Client{Timeout: 10 * time.Second}

func baseURL(t *testing.T) string {
	t.Helper()
	u := os.Getenv("BASE_URL")
	if u == "" {
		t.Skip("BASE_URL not set; run through scripts/contract.sh")
	}
	return strings.TrimRight(u, "/")
}

func schemas(t *testing.T) *Schemas {
	t.Helper()
	s, err := LoadSchemas("../../api/openapi.yaml")
	if err != nil {
		t.Fatal(err)
	}
	return s
}

type response struct {
	code   int
	header http.Header
	body   []byte
}

func call(t *testing.T, method, url string, headers map[string]string) response {
	t.Helper()
	req, err := http.NewRequestWithContext(t.Context(), method, url, nil)
	if err != nil {
		t.Fatal(err)
	}
	for k, v := range headers {
		req.Header.Set(k, v)
	}
	resp, err := client.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = resp.Body.Close() }()
	body, err := io.ReadAll(resp.Body)
	if err != nil {
		t.Fatal(err)
	}
	return response{resp.StatusCode, resp.Header, body}
}

func getValid(t *testing.T, s *Schemas, url, schema string) response {
	t.Helper()
	r := call(t, http.MethodGet, url, nil)
	if r.code != http.StatusOK {
		t.Fatalf("GET %s = %d: %s", url, r.code, r.body)
	}
	if ct := r.header.Get("Content-Type"); !strings.HasPrefix(ct, "application/json") {
		t.Fatalf("GET %s Content-Type = %q", url, ct)
	}
	if err := s.Validate(schema, r.body); err != nil {
		t.Fatalf("GET %s does not match %s:\n%v", url, schema, err)
	}
	return r
}

func TestDataEndpointsMatchTheSchema(t *testing.T) {
	base, s := baseURL(t), schemas(t)
	r := getValid(t, s, base+"/api/v1/summary", "Summary")
	for _, h := range []string{"ETag", "Last-Modified", "Cache-Control", "X-Request-ID"} {
		if r.header.Get(h) == "" {
			t.Errorf("summary missing %s", h)
		}
	}
	var sum summary
	if err := json.Unmarshal(r.body, &sum); err != nil {
		t.Fatal(err)
	}
	for _, p := range sum.Products {
		getValid(t, s, base+"/api/v1/products/"+p.ID, "ProductDetail")
	}
	getValid(t, s, base+"/api/v1/incidents", "IncidentList")
	getValid(t, s, base+"/healthz", "Probe")
	getValid(t, s, base+"/readyz", "Probe")
}

// TestRollUpInvariants pins the status semantics every implementation must
// share, whatever the data.
func TestRollUpInvariants(t *testing.T) {
	base := baseURL(t)
	var sum summary
	r := call(t, http.MethodGet, base+"/api/v1/summary", nil)
	if err := json.Unmarshal(r.body, &sum); err != nil {
		t.Fatal(err)
	}
	if len(sum.Products) == 0 {
		t.Fatal("summary has no products")
	}
	productStatuses := make([]string, 0, len(sum.Products))
	complete := true
	for _, p := range sum.Products {
		productStatuses = append(productStatuses, p.Status)
		complete = complete && p.DataComplete && p.Status != "unknown"
		checkProductInvariants(t, base, p, len(sum.Products[0].History))
	}
	// The overall status fails closed: unknown when data is missing and no
	// problem is known, otherwise the worst known product status.
	if want := failClosed(productStatuses, complete); sum.Status != want {
		t.Errorf("overall status = %s, want %s (worst of products %v, data complete %v)", sum.Status, failClosed(productStatuses, complete), productStatuses, complete)
	}
	if sum.DataComplete != complete {
		t.Errorf("summary data_complete = %v, want %v (every product complete and its status known)", sum.DataComplete, complete)
	}
	for _, inc := range sum.ActiveIncidents {
		if inc.ResolvedAt != nil {
			t.Errorf("active incident %s has resolved_at", inc.ID)
		}
	}
}

func checkProductInvariants(t *testing.T, base string, p product, historyLen int) {
	t.Helper()
	var detail product
	r := call(t, http.MethodGet, base+"/api/v1/products/"+p.ID, nil)
	if err := json.Unmarshal(r.body, &detail); err != nil {
		t.Fatal(err)
	}
	checkFeeds(t, p.ID+" (summary row)", p)
	checkFeeds(t, p.ID, detail)
	statuses := make([]string, 0, len(p.Regions))
	affected, ids := 0, map[string]bool{}
	for _, r := range p.Regions {
		statuses = append(statuses, r.Status)
		if severity[r.Status] > severity["operational"] {
			affected++
		}
		if r.ID == "" || ids[r.ID] {
			t.Errorf("%s: region id %q is empty or not unique", p.ID, r.ID)
		}
		ids[r.ID] = true
	}
	if complete := dataComplete(detail.RegionDetails); p.AffectedRegions != affected || p.DataComplete != complete {
		t.Errorf("%s: affected=%d complete=%v, want %d %v (complete: every region and component known)", p.ID, p.AffectedRegions, p.DataComplete, affected, complete)
	}
	if len(p.History) != historyLen {
		t.Errorf("%s: history length %d, want %d like every product", p.ID, len(p.History), historyLen)
	}
	for i, inc := range detail.Incidents {
		if inc.ResolvedAt == nil {
			statuses = append(statuses, effectiveImpact(inc.Impact))
		}
		for _, other := range detail.Incidents[:i] {
			if sameEvent(t, inc, other) {
				t.Errorf("%s: incidents %s and %s share title, impact and state, and start and end within 60 s; want them listed once", p.ID, other.ID, inc.ID)
			}
		}
	}
	if want := worst(statuses...); p.Status != want {
		t.Errorf("%s: status = %s, want worst of regions and active incidents (unknown impact as degraded) = %s", p.ID, p.Status, want)
	}
	if detail.Status != p.Status || detail.DataComplete != p.DataComplete || detail.Outdated != p.Outdated || detail.Stale != p.Stale ||
		!reflect.DeepEqual(detail.Regions, p.Regions) || !reflect.DeepEqual(detail.Locations, p.Locations) {
		t.Errorf("%s: detail disagrees with the summary row", p.ID)
	}
	checkLocations(t, p, detail.RegionDetails)
}

// checkLocations: every region's location is one of the product's, each
// location has regions and they are listed together, in the locations'
// order and by name, before the regions without one; a location's status
// fails closed over theirs; each summary region matches its detail, uptime
// included.
func checkLocations(t *testing.T, p product, details []regionDetail) {
	t.Helper()
	index := map[string]int{}
	statuses := make([][]string, len(p.Locations))
	complete := make([]bool, len(p.Locations))
	for i, l := range p.Locations {
		if _, dup := index[l.ID]; dup {
			t.Errorf("%s: location id %q is not unique", p.ID, l.ID)
		}
		index[l.ID] = i
		complete[i] = true
	}
	last, lastName := -1, ""
	for i, r := range p.Regions {
		if i >= len(details) || details[i].ID != r.ID || details[i].Location != r.Location || !reflect.DeepEqual(details[i].Uptime, r.Uptime) {
			t.Errorf("%s: region %d (%s) differs from region_details[%d]", p.ID, i, r.ID, i)
		}
		if r.Location == "" {
			last = len(p.Locations)
			continue
		}
		at, ok := index[r.Location]
		switch {
		case !ok:
			t.Errorf("%s: region %s names location %q, which is not listed", p.ID, r.ID, r.Location)
			continue
		case at < last || (at == last && r.Name < lastName):
			t.Errorf("%s: region %s is out of order: want each location's regions together, by name, before those without one", p.ID, r.ID)
		}
		last, lastName = at, r.Name
		statuses[at] = append(statuses[at], r.Status)
		complete[at] = complete[at] && r.Status != "unknown"
	}
	for i, l := range p.Locations {
		if len(statuses[i]) == 0 {
			t.Errorf("%s: location %s has no region", p.ID, l.ID)
		}
		if want := failClosed(statuses[i], complete[i]); l.Status != want {
			t.Errorf("%s: location %s = %s, want %s (worst of %v, unknown when one is and no problem is known)", p.ID, l.ID, l.Status, want, statuses[i])
		}
	}
}

// failClosed is the roll-up of the overall status and of each location:
// unknown when data is missing and no problem (maintenance or worse) is
// known, otherwise the worst known status.
func failClosed(statuses []string, complete bool) string {
	w := worst(statuses...)
	if !complete && severity[w] <= severity["operational"] {
		return "unknown"
	}
	return w
}

// sameEvent reports whether two incidents of one product are records of one
// event: the same title, impact and open or resolved state, with starts and
// ends each at most 60 s apart.
func sameEvent(t *testing.T, a, b incident) bool {
	t.Helper()
	if a.Title != b.Title || a.Impact != b.Impact || (a.ResolvedAt == nil) != (b.ResolvedAt == nil) {
		return false
	}
	near := func(x, y string) bool {
		tx, errX := time.Parse(time.RFC3339, x)
		ty, errY := time.Parse(time.RFC3339, y)
		if errX != nil || errY != nil {
			t.Fatalf("incident times %q, %q: %v %v", x, y, errX, errY)
		}
		return tx.Sub(ty).Abs() <= time.Minute
	}
	if !near(a.StartedAt, b.StartedAt) {
		return false
	}
	return a.ResolvedAt == nil || near(*a.ResolvedAt, *b.ResolvedAt)
}

// checkFeeds holds the per-kind freshness rules: outdated is stale
// incidents or stale uptime, a kind never checked (null) is stale, and stale
// components leave some region unknown, so the data is incomplete (every
// shipped source names regions).
func checkFeeds(t *testing.T, name string, p product) {
	t.Helper()
	if want := p.Stale.Incidents || p.Stale.Uptime; p.Outdated != want {
		t.Errorf("%s: outdated = %v, want stale.incidents || stale.uptime = %v", name, p.Outdated, want)
	}
	for kind, c := range map[string]struct {
		at    *string
		stale bool
	}{
		"components": {p.CheckedAt.Components, p.Stale.Components},
		"incidents":  {p.CheckedAt.Incidents, p.Stale.Incidents},
		"uptime":     {p.CheckedAt.Uptime, p.Stale.Uptime},
	} {
		if c.at == nil && !c.stale {
			t.Errorf("%s: checked_at.%s is null but stale.%s is false", name, kind, kind)
		}
	}
	if p.Stale.Components && p.DataComplete {
		t.Errorf("%s: stale.components with data_complete true", name)
	}
}

// dataComplete is true when there are regions and every region and every
// component in them has a known status.
func dataComplete(regions []regionDetail) bool {
	for _, r := range regions {
		if r.Status == "unknown" {
			return false
		}
		for _, g := range r.Groups {
			for _, c := range g.Components {
				if c.Status == "unknown" {
					return false
				}
			}
		}
	}
	return len(regions) > 0
}

// TestBodyFreshness: every data body carries generated_at, and every
// product checked_at, as RFC 3339 UTC floored to the minute. generated_at is
// never newer than the response's Date and at most generatedAtMaxAge older,
// no checked_at is newer than the generated_at of its body, and
// Last-Modified is never later than Date.
func TestBodyFreshness(t *testing.T) {
	base := baseURL(t)
	var sum summary
	r := call(t, http.MethodGet, base+"/api/v1/summary", nil)
	if err := json.Unmarshal(r.body, &sum); err != nil {
		t.Fatal(err)
	}
	generated := checkGeneratedAt(t, "summary", sum.GeneratedAt, r.header)
	for _, p := range sum.Products {
		checkCheckedAt(t, p.ID+" (summary row)", p.CheckedAt, generated)
		var detail product
		rd := call(t, http.MethodGet, base+"/api/v1/products/"+p.ID, nil)
		if err := json.Unmarshal(rd.body, &detail); err != nil {
			t.Fatal(err)
		}
		checkCheckedAt(t, p.ID, detail.CheckedAt, checkGeneratedAt(t, p.ID, detail.GeneratedAt, rd.header))
	}
	var list struct {
		GeneratedAt string `json:"generated_at"`
	}
	ri := call(t, http.MethodGet, base+"/api/v1/incidents", nil)
	if err := json.Unmarshal(ri.body, &list); err != nil {
		t.Fatal(err)
	}
	checkGeneratedAt(t, "incidents", list.GeneratedAt, ri.header)
}

// minuteTime parses an RFC 3339 UTC timestamp floored to the minute.
func minuteTime(t *testing.T, name, value string) time.Time {
	t.Helper()
	at, err := time.Parse(time.RFC3339, value)
	if err != nil {
		t.Fatalf("%s %q is not RFC 3339: %v", name, value, err)
	}
	if !strings.HasSuffix(value, ":00Z") || at.Second() != 0 || at.Nanosecond() != 0 {
		t.Errorf("%s %q is not UTC floored to the minute", name, value)
	}
	return at
}

// generatedAtMaxAge bounds Date minus generated_at. The server writes both
// from its own clock, so the age is the minute generated_at is floored by
// plus the time since the last build. A build follows every poll, and the
// contract configuration (config/statusd.yaml) polls components and
// incidents of each of its seven sources every 30 s with at most 5% jitter,
// against a local fixture upstream, so the last build is at most about 32 s
// old: about 92 s in all. The rest is room for a CI runner that stalls the
// poll loop. A frozen snapshot does not show within a contract run, which
// lasts seconds, so a wider bound loses nothing; the bound catches a
// generated_at that is not the build time at all.
const generatedAtMaxAge = 3 * time.Minute

// checkGeneratedAt checks a body's generated_at against the response's Date,
// and the response's Last-Modified, which must not be later than Date (RFC
// 9110 section 8.8.2.1).
func checkGeneratedAt(t *testing.T, name, value string, header http.Header) time.Time {
	t.Helper()
	at := minuteTime(t, name+" generated_at", value)
	date, err := http.ParseTime(header.Get("Date"))
	if err != nil {
		t.Fatalf("%s: Date %q: %v", name, header.Get("Date"), err)
	}
	if age := date.Sub(at); age < 0 || age > generatedAtMaxAge {
		t.Errorf("%s: generated_at %s is %v older than Date %s, want 0 to %v", name, value, age, header.Get("Date"), generatedAtMaxAge)
	}
	if lm, err := http.ParseTime(header.Get("Last-Modified")); err != nil || lm.After(date) {
		t.Errorf("%s: Last-Modified %q is not an HTTP date before or at Date %s", name, header.Get("Last-Modified"), header.Get("Date"))
	}
	return at
}

func checkCheckedAt(t *testing.T, name string, c checkedAt, generated time.Time) {
	t.Helper()
	for kind, v := range map[string]*string{"components": c.Components, "incidents": c.Incidents, "uptime": c.Uptime} {
		if v == nil {
			continue
		}
		if at := minuteTime(t, name+" checked_at."+kind, *v); at.After(generated) {
			t.Errorf("%s: checked_at.%s %s is after generated_at %s", name, kind, *v, generated.Format(time.RFC3339))
		}
	}
}

func TestIncidentsAreNewestFirst(t *testing.T) {
	base := baseURL(t)
	var list struct {
		Incidents []incident `json:"incidents"`
	}
	if err := json.Unmarshal(call(t, http.MethodGet, base+"/api/v1/incidents", nil).body, &list); err != nil {
		t.Fatal(err)
	}
	for i := 1; i < len(list.Incidents); i++ {
		prev, _ := time.Parse(time.RFC3339, list.Incidents[i-1].StartedAt)
		cur, _ := time.Parse(time.RFC3339, list.Incidents[i].StartedAt)
		if cur.After(prev) {
			t.Fatalf("incident %s is out of order", list.Incidents[i].ID)
		}
	}
}

// problems collects what a check found, so a check that compares two
// responses can be run again (whileUnchanged).
type problems []string

func (p *problems) add(format string, args ...any) {
	*p = append(*p, fmt.Sprintf(format, args...))
}

// whileUnchanged runs check, which compares two or more responses for url,
// and runs it again (up to three times in all) when it found problems and
// url's ETag changed meanwhile: every body changes when the minute of its
// generated_at does, and a check can straddle that. The problems of the
// last run fail the test.
func whileUnchanged(t *testing.T, url string, check func(*problems)) {
	t.Helper()
	var found problems
	for range 3 {
		found = nil
		before := call(t, http.MethodGet, url, nil).header.Get("ETag")
		check(&found)
		if len(found) == 0 || call(t, http.MethodGet, url, nil).header.Get("ETag") == before {
			break
		}
	}
	for _, p := range found {
		t.Error(p)
	}
}

func TestHTTPSemantics(t *testing.T) {
	base, s := baseURL(t), schemas(t)
	summaryURL := base + "/api/v1/summary"
	whileUnchanged(t, summaryURL, func(found *problems) { checkConditionalAndGzip(t, summaryURL, found) })

	if r := call(t, http.MethodHead, summaryURL, nil); r.code != http.StatusOK || len(r.body) != 0 {
		t.Errorf("HEAD: %d with %d bytes", r.code, len(r.body))
	}
	if r := call(t, http.MethodGet, summaryURL, map[string]string{"Origin": "https://example.com"}); r.header.Get("Access-Control-Allow-Origin") == "" {
		t.Error("cross-origin GET has no Access-Control-Allow-Origin")
	}

	notFound := call(t, http.MethodGet, base+"/api/v1/products/no-such-product", nil)
	if notFound.code != http.StatusNotFound || !strings.HasPrefix(notFound.header.Get("Content-Type"), "application/problem+json") {
		t.Errorf("unknown product: %d %s", notFound.code, notFound.header.Get("Content-Type"))
	} else if err := s.Validate("Problem", notFound.body); err != nil {
		t.Errorf("unknown product problem body: %v", err)
	}
	if r := call(t, http.MethodPost, summaryURL, nil); r.code != http.StatusMethodNotAllowed || r.header.Get("Allow") == "" {
		t.Errorf("POST: %d Allow=%q, want 405 with Allow", r.code, r.header.Get("Allow"))
	}
}

// checkConditionalAndGzip: the validators of one response answer 304 when
// sent back, and the gzip body is the plain body compressed. The plain
// requests go through rawClient, which sends no Accept-Encoding.
func checkConditionalAndGzip(t *testing.T, summaryURL string, found *problems) {
	t.Helper()
	plain := sendLines(t, summaryURL, "If-None-Match", nil)
	etag := plain.header.Get("ETag")
	for _, inm := range []string{etag, "W/" + etag} {
		if r := sendLines(t, summaryURL, "If-None-Match", []string{inm}); r.code != http.StatusNotModified || len(r.body) != 0 {
			found.add("If-None-Match %q: %d with %d bytes, want 304 and no body", inm, r.code, len(r.body))
		}
	}

	lastModified := plain.header.Get("Last-Modified")
	if _, err := http.ParseTime(lastModified); err != nil {
		found.add("Last-Modified %q is not an HTTP date", lastModified)
	}
	if r := call(t, http.MethodGet, summaryURL, map[string]string{"If-Modified-Since": lastModified}); r.code != http.StatusNotModified {
		found.add("If-Modified-Since = Last-Modified: %d, want 304", r.code)
	}
	precedence := map[string]string{"If-Modified-Since": lastModified, "If-None-Match": `"not-the-etag"`}
	if r := call(t, http.MethodGet, summaryURL, precedence); r.code != http.StatusOK {
		found.add("If-None-Match must take precedence over If-Modified-Since: %d, want 200", r.code)
	}

	gz := call(t, http.MethodGet, summaryURL, map[string]string{"Accept-Encoding": "gzip"})
	if gz.header.Get("Content-Encoding") != "gzip" {
		found.add("Accept-Encoding gzip: Content-Encoding = %q", gz.header.Get("Content-Encoding"))
	} else if zr, err := gzip.NewReader(bytes.NewReader(gz.body)); err != nil {
		found.add("gzip body: %v", err)
	} else if unzipped, _ := io.ReadAll(zr); !bytes.Equal(unzipped, plain.body) {
		found.add("gzip body differs from the plain body")
	}
}

// TestEveryResponseIsCacheExplicit guards the CDN: a response without
// Cache-Control may be cached for days by Azure Front Door. Requests go out
// exactly as written (no redirects followed), so a router's own answers are
// covered too.
func TestEveryResponseIsCacheExplicit(t *testing.T) {
	base := baseURL(t)
	origin := map[string]string{"Origin": "https://example.com"}
	cases := []probe{
		{method: http.MethodGet, path: "/api/v1/summary"},
		{method: http.MethodGet, path: "/api/v1/incidents"},
		{method: http.MethodGet, path: "/api/v1/products/no-such-product"},
		{method: http.MethodGet, path: "/api/v1/products/"},
		{method: http.MethodGet, path: "/no/such/path"},
		{method: http.MethodHead, path: "/no/such/path"},
		{method: http.MethodPost, path: "/api/v1/summary"},
		{method: http.MethodDelete, path: "/healthz"},
		{method: http.MethodOptions, path: "/api/v1/summary", headers: origin},
		{method: http.MethodGet, path: "/api//v1/summary"},
		{method: http.MethodGet, path: "/healthz"},
		{method: http.MethodGet, path: "/readyz"},
	}
	for _, c := range cases {
		if r := c.send(t, base); r.header.Get("Cache-Control") == "" {
			t.Errorf("%s (%d) has no Cache-Control", c, r.code)
		}
	}
	if cc := call(t, http.MethodGet, base+"/no/such/path", nil).header.Get("Cache-Control"); strings.Contains(cc, "no-store") {
		t.Errorf("404 Cache-Control = %q; random-path floods would all reach the origin", cc)
	}
}

// TestEncodedPaths: a percent-encoded spelling of a data path is not the
// data. Each spelling would be a separate CDN cache entry, so it gets the
// cacheable 404 for unknown paths.
func TestEncodedPaths(t *testing.T) {
	base := baseURL(t)
	for _, path := range []string{"/api/v1/%73ummary", "/api/v1/sum%6dary", "/api/v1/%69ncidents", "/api/v1/products/mo%65sif"} {
		p := probe{method: http.MethodGet, path: path}
		r := p.send(t, base)
		if r.code != http.StatusNotFound {
			t.Errorf("%s: %d, want 404", p, r.code)
		}
		if cc := r.header.Get("Cache-Control"); cc == "" || strings.Contains(cc, "no-store") {
			t.Errorf("%s: Cache-Control %q, want the cacheable 404", p, cc)
		}
	}
}

// TestAcceptEncoding runs the content negotiation table the handler tests share.
func TestAcceptEncoding(t *testing.T) {
	base := baseURL(t)
	raw, err := os.ReadFile("../../testdata/http/accept-encoding.json")
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
	for _, c := range table.Cases {
		r := probe{method: http.MethodGet, path: "/api/v1/summary", headers: map[string]string{"Accept-Encoding": c.Header}}.send(t, base)
		if got := r.header.Get("Content-Encoding") == "gzip"; got != c.Gzip {
			t.Errorf("Accept-Encoding %q: gzip = %v, want %v", c.Header, got, c.Gzip)
		}
		if _, ok := decodedBody(t, r).(map[string]any); !ok {
			t.Errorf("Accept-Encoding %q: body is not a JSON object", c.Header)
		}
	}
	summaryURL := base + "/api/v1/summary"
	whileUnchanged(t, summaryURL, func(found *problems) { checkETagPerEncoding(t, base, found) })
}

// checkETagPerEncoding: the plain and gzip bodies are two representations
// with distinct strong ETags (RFC 9110 section 8.8.3.3), and If-None-Match
// answers 304 only with the selected representation's tag.
func checkETagPerEncoding(t *testing.T, base string, found *problems) {
	t.Helper()
	const path = "/api/v1/summary"
	plainTag := probe{method: http.MethodGet, path: path}.send(t, base).header.Get("ETag")
	gzipTag := probe{method: http.MethodGet, path: path, headers: map[string]string{"Accept-Encoding": "gzip"}}.send(t, base).header.Get("ETag")
	if plainTag == "" || gzipTag == plainTag || strings.HasPrefix(gzipTag, "W/") || strings.HasPrefix(plainTag, "W/") {
		found.add("plain ETag %s, gzip ETag %s: want two distinct strong tags", plainTag, gzipTag)
		return
	}
	cases := []struct {
		accept, inm string
		code        int
	}{
		{"gzip", gzipTag, http.StatusNotModified},
		{"gzip", plainTag, http.StatusOK},
		{"identity", plainTag, http.StatusNotModified},
		{"identity", gzipTag, http.StatusOK},
	}
	for _, c := range cases {
		p := probe{method: http.MethodGet, path: path, headers: map[string]string{"Accept-Encoding": c.accept, "If-None-Match": c.inm}}
		if r := p.send(t, base); r.code != c.code {
			found.add("%s: %d, want %d", p, r.code, c.code)
		}
	}
}

// TestRepeatedHeaderLines: a list header sent as several lines means the
// same as one line with the values joined by commas (RFC 9110 section 5.3).
// The shared accept-encoding table holds one line per case, so these cases
// live here.
func TestRepeatedHeaderLines(t *testing.T) {
	base := baseURL(t)
	summaryURL := base + "/api/v1/summary"
	whileUnchanged(t, summaryURL, func(found *problems) { checkRepeatedHeaderLines(t, summaryURL, found) })
}

func checkRepeatedHeaderLines(t *testing.T, summaryURL string, found *problems) {
	t.Helper()
	// sendLines sends no Accept-Encoding, so the plain body's tag applies.
	etag := sendLines(t, summaryURL, "Accept-Encoding", nil).header.Get("ETag")
	cases := []struct {
		header string
		lines  []string
		code   int
		gzip   bool
	}{
		{"Accept-Encoding", []string{"br", "gzip"}, http.StatusOK, true},
		{"Accept-Encoding", []string{"*", "gzip;q=0"}, http.StatusOK, false},
		{"Accept-Encoding", []string{"br", "deflate"}, http.StatusOK, false},
		{"If-None-Match", []string{`"other"`, etag}, http.StatusNotModified, false},
		{"If-None-Match", []string{`"a"`, `"b"`}, http.StatusOK, false},
	}
	for _, c := range cases {
		r := sendLines(t, summaryURL, c.header, c.lines)
		if gz := r.header.Get("Content-Encoding") == "gzip"; r.code != c.code || gz != c.gzip {
			found.add("%s %q: %d gzip=%v, want %d gzip=%v", c.header, c.lines, r.code, gz, c.code, c.gzip)
			continue
		}
		if _, ok := decodedBody(t, r).(map[string]any); c.code == http.StatusOK && !ok {
			found.add("%s %q: body is not a JSON object", c.header, c.lines)
		}
	}
}

// sendLines sends a GET with one header line per value of the named header.
func sendLines(t *testing.T, url, name string, lines []string) response {
	t.Helper()
	req, err := http.NewRequestWithContext(t.Context(), http.MethodGet, url, nil)
	if err != nil {
		t.Fatal(err)
	}
	for _, line := range lines {
		req.Header.Add(name, line)
	}
	resp, err := rawClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = resp.Body.Close() }()
	body, err := io.ReadAll(resp.Body)
	if err != nil {
		t.Fatal(err)
	}
	return response{resp.StatusCode, resp.Header, body}
}

// TestIfModifiedSince covers the validator Azure Front Door uses: it
// revalidates with If-Modified-Since only. A 304 carries the headers a cache
// refreshes its copy with.
func TestIfModifiedSince(t *testing.T) {
	base := baseURL(t)
	summaryURL := base + "/api/v1/summary"
	whileUnchanged(t, summaryURL, func(found *problems) { checkIfModifiedSince(t, summaryURL, found) })
}

func checkIfModifiedSince(t *testing.T, summaryURL string, found *problems) {
	t.Helper()
	lastModified, err := http.ParseTime(call(t, http.MethodGet, summaryURL, nil).header.Get("Last-Modified"))
	if err != nil {
		t.Fatal(err)
	}
	cases := []struct {
		name, value string
		want        int
	}{
		{"equal", lastModified.Format(http.TimeFormat), http.StatusNotModified},
		{"earlier", lastModified.Add(-time.Second).Format(http.TimeFormat), http.StatusOK},
		{"future", lastModified.Add(24 * time.Hour).Format(http.TimeFormat), http.StatusNotModified},
		{"garbage", "not a date", http.StatusOK},
	}
	for _, c := range cases {
		r := call(t, http.MethodGet, summaryURL, map[string]string{"If-Modified-Since": c.value})
		if r.code != c.want {
			found.add("If-Modified-Since %s: %d, want %d", c.name, r.code, c.want)
			continue
		}
		if r.code != http.StatusNotModified {
			continue
		}
		for _, h := range []string{"ETag", "Cache-Control", "Vary"} {
			if r.header.Get(h) == "" {
				found.add("If-Modified-Since %s: 304 without %s", c.name, h)
			}
		}
	}
}

// TestPreflight is the browser's CORS preflight for a conditional request.
func TestPreflight(t *testing.T) {
	base := baseURL(t)
	r := probe{method: http.MethodOptions, path: "/api/v1/summary", headers: map[string]string{
		"Origin":                         "https://example.com",
		"Access-Control-Request-Method":  http.MethodGet,
		"Access-Control-Request-Headers": "if-modified-since",
	}}.send(t, base)
	if r.code != http.StatusNoContent || r.header.Get("Access-Control-Allow-Origin") == "" {
		t.Fatalf("preflight: %d, Access-Control-Allow-Origin %q", r.code, r.header.Get("Access-Control-Allow-Origin"))
	}
	if methods := r.header.Get("Access-Control-Allow-Methods"); !strings.Contains(methods, http.MethodGet) {
		t.Errorf("Access-Control-Allow-Methods = %q, want GET", methods)
	}
	if headers := strings.ToLower(r.header.Get("Access-Control-Allow-Headers")); !strings.Contains(headers, "if-modified-since") || !strings.Contains(headers, "if-none-match") {
		t.Errorf("Access-Control-Allow-Headers = %q, want both conditional headers", headers)
	}
	if r.header.Get("Cache-Control") == "" || r.header.Get("Access-Control-Max-Age") == "" {
		t.Errorf("preflight Cache-Control %q, Max-Age %q", r.header.Get("Cache-Control"), r.header.Get("Access-Control-Max-Age"))
	}
}

// TestFixtureExpectations holds when the backend reads the captured
// fixtures through the shipped product catalog (scripts/contract.sh).
func TestFixtureExpectations(t *testing.T) {
	base := baseURL(t)
	if os.Getenv("CONTRACT_FIXTURES") != "1" {
		t.Skip("CONTRACT_FIXTURES != 1")
	}
	want := configuredRegions(t)
	var sum summary
	if err := json.Unmarshal(call(t, http.MethodGet, base+"/api/v1/summary", nil).body, &sum); err != nil {
		t.Fatal(err)
	}
	if sum.Status != "operational" || !sum.DataComplete || len(sum.Products) != len(want) {
		t.Fatalf("status %s, data_complete %v, with %d products", sum.Status, sum.DataComplete, len(sum.Products))
	}
	for _, p := range sum.Products {
		if len(p.Regions) != want[p.ID] || !p.DataComplete || p.Outdated || p.Status != "operational" {
			t.Errorf("%s: %d regions (want %d), complete=%v, outdated=%v, status=%s", p.ID, len(p.Regions), want[p.ID], p.DataComplete, p.Outdated, p.Status)
		}
		if c := p.CheckedAt; c.Components == nil || c.Incidents == nil || c.Uptime == nil || p.Stale != (staleFlags{}) {
			t.Errorf("%s: checked_at %+v, stale %+v; want every kind checked and none stale", p.ID, c, p.Stale)
		}
	}
	checkCollapsedIncidents(t, base)
}

// configuredRegions reads config/statusd.yaml, the catalogue the backend
// runs with here: per product id, how many regions it names.
func configuredRegions(t *testing.T) map[string]int {
	t.Helper()
	raw, err := os.ReadFile("../../config/statusd.yaml")
	if err != nil {
		t.Fatal(err)
	}
	var cfg struct {
		Products []struct {
			ID      string `yaml:"id"`
			Sources []struct {
				Regions []struct{} `yaml:"regions"`
			} `yaml:"sources"`
		} `yaml:"products"`
	}
	if err := yaml.Unmarshal(raw, &cfg); err != nil {
		t.Fatal(err)
	}
	regions := map[string]int{}
	for _, p := range cfg.Products {
		for _, s := range p.Sources {
			regions[p.ID] += len(s.Regions)
		}
	}
	return regions
}

// checkCollapsedIncidents: the captured choreo history files two incidents
// as two identical records each, and the 17 Aug 2026 one as two records 18 s
// apart at the start and 10 s at the end. Each is listed once, under the
// smaller id, and the history refers to that id only.
func checkCollapsedIncidents(t *testing.T, base string) {
	t.Helper()
	var detail product
	if err := json.Unmarshal(call(t, http.MethodGet, base+"/api/v1/products/developer-platform", nil).body, &detail); err != nil {
		t.Fatal(err)
	}
	listed := map[string]bool{}
	for _, inc := range detail.Incidents {
		listed[inc.ID] = true
	}
	referenced := map[string]bool{}
	for _, d := range detail.History {
		for _, id := range d.IncidentIDs {
			referenced[id] = true
		}
	}
	if len(detail.History) == 0 {
		t.Fatal("developer-platform has no history")
	}
	// A product lists the incidents that overlap its history window, so a
	// pair is listed only while the kept record ended after the window began.
	windowStart, err := time.Parse(time.DateOnly, detail.History[0].Date)
	if err != nil {
		t.Fatal(err)
	}
	for _, pair := range []struct {
		kept, dropped string
		ended         string // the kept record's end, UTC, from the fixture
	}{
		{"c6a4127fc30a8710af2f40459901318d", "c9935e7bc30a8710af2f40459901310d", "2026-07-20T02:19:28Z"},
		{"4354123fc30a8710af2f4045990131e4", "afd25ef7c30a8710af2f404599013134", "2026-07-20T02:19:28Z"},
		{"563011cd97328710182338f11153affc", "63221d8197728710182338f11153afc8", "2026-08-17T17:05:43Z"},
	} {
		ended, err := time.Parse(time.RFC3339, pair.ended)
		if err != nil {
			t.Fatal(err)
		}
		inWindow := ended.After(windowStart)
		if !inWindow {
			t.Logf("%s ended before the history window (%s); only its duplicate's absence is checked", pair.kept, detail.History[0].Date)
		}
		if listed[pair.kept] != inWindow || listed[pair.dropped] || referenced[pair.dropped] {
			t.Errorf("developer-platform lists %s: %v (in the window: %v) and %s: %v (history refers to it: %v); want only the first of the pair, while in the window",
				pair.kept, listed[pair.kept], inWindow, pair.dropped, listed[pair.dropped], referenced[pair.dropped])
		}
	}
}

// TestEdgeScenario reads the data scripts/contract.sh overlays from
// testdata/contract-edge (CONTRACT_SCENARIO=edge): what the captured
// fixtures never show, read the same way by every implementation.
func TestEdgeScenario(t *testing.T) {
	base := baseURL(t)
	if os.Getenv("CONTRACT_SCENARIO") != "edge" {
		t.Skip("CONTRACT_SCENARIO != edge")
	}
	products := map[string]product{}
	var sum summary
	if err := json.Unmarshal(call(t, http.MethodGet, base+"/api/v1/summary", nil).body, &sum); err != nil {
		t.Fatal(err)
	}
	for _, p := range sum.Products {
		var detail product
		if err := json.Unmarshal(call(t, http.MethodGet, base+"/api/v1/products/"+p.ID, nil).body, &detail); err != nil {
			t.Fatal(err)
		}
		products[p.ID] = detail
	}
	t.Run("colliding and empty region keys get unique ids", func(t *testing.T) {
		checkEdgeRegions(t, products["moesif"])
	})
	t.Run("a null or missing component status is unknown", func(t *testing.T) {
		checkEdgeComponents(t, products["moesif"])
		if sum.DataComplete {
			t.Error("summary data_complete = true while moesif's data is incomplete")
		}
	})
	t.Run("an unrecognised incident type counts as degraded", func(t *testing.T) {
		checkEdgeIncident(t, products["api-platform"], sum)
	})
	t.Run("a source that returns {} for incidents hides neither the other's incidents nor the gap", func(t *testing.T) {
		checkEdgeMerge(t, products["developer-platform"])
	})
	t.Run("outage, maintenance and degraded regions are affected, and an unconfigured region comes last", func(t *testing.T) {
		checkEdgeAgentRegions(t, products["agent-platform"])
	})
	t.Run("a Maintenance incident has impact maintenance", func(t *testing.T) {
		checkEdgeMaintenance(t, products["integration-platform"], sum)
	})
	t.Run("every status value occurs in some region", func(t *testing.T) {
		checkEveryStatus(t, sum)
	})
	t.Run("a silent source of a multi-source product leaves only its own regions unknown", func(t *testing.T) {
		checkEdgeSilentSibling(t, products["developer-platform"])
	})
	t.Run("checked_at is null and stale is true exactly for the kinds never answered", func(t *testing.T) {
		checkEdgeFeeds(t, products)
	})
}

// checkEdgeAgentRegions: agent-manager answers with an outage component in
// its US control plane, a maintenance one in its US data plane, and a
// degraded one under "ap - 9", a key the configuration does not name. Each
// region takes its worst component and counts as affected, and the
// unconfigured region has no location and comes after the located ones.
func checkEdgeAgentRegions(t *testing.T, p product) {
	t.Helper()
	want := []region{
		{ID: "us-control-plane", Location: "us", Status: "outage"},
		{ID: "us-data-plane", Location: "us", Status: "maintenance"},
		{ID: "ap-9", Status: "degraded"},
	}
	if len(p.Regions) != len(want) {
		t.Fatalf("agent-platform regions = %+v, want %d", p.Regions, len(want))
	}
	for i, r := range p.Regions {
		if r.ID != want[i].ID || r.Location != want[i].Location || r.Status != want[i].Status {
			t.Errorf("agent-platform region %d = %s (location %q) %s, want %s (location %q) %s",
				i, r.ID, r.Location, r.Status, want[i].ID, want[i].Location, want[i].Status)
		}
	}
	if p.AffectedRegions != len(want) || p.Status != "outage" || !p.DataComplete {
		t.Errorf("agent-platform: affected_regions %d, status %s, data_complete %v; want %d, outage, true",
			p.AffectedRegions, p.Status, p.DataComplete, len(want))
	}
	if len(p.Locations) != 1 || p.Locations[0].ID != "us" || p.Locations[0].Status != "outage" {
		t.Errorf("agent-platform locations = %+v, want us only, outage", p.Locations)
	}
}

// checkEdgeMaintenance: devant has an active incident of type Maintenance.
// Its impact is maintenance, it raises the product, whose regions are
// operational, to maintenance without affecting a region, today is a
// maintenance day, and the summary lists it as active.
func checkEdgeMaintenance(t *testing.T, p product, sum summary) {
	t.Helper()
	var planned *incident
	for i, inc := range p.Incidents {
		if inc.ID == "edge-maintenance" {
			planned = &p.Incidents[i]
		}
	}
	if planned == nil || planned.Impact != "maintenance" || planned.ResolvedAt != nil {
		t.Fatalf("integration-platform incident = %+v, want active with impact maintenance", planned)
	}
	if p.Status != "maintenance" || p.AffectedRegions != 0 {
		t.Errorf("integration-platform: status %s, affected_regions %d; want maintenance, 0", p.Status, p.AffectedRegions)
	}
	if today := p.History[len(p.History)-1]; today.Status != "maintenance" {
		t.Errorf("integration-platform today = %+v, want maintenance", today)
	} else if _, ok := today.Minutes["maintenance"]; !ok {
		t.Errorf("integration-platform today = %+v, want maintenance minutes", today)
	}
	found := false
	for _, inc := range sum.ActiveIncidents {
		found = found || inc.ID == planned.ID
	}
	if !found {
		t.Error("the maintenance incident is missing from the summary's active incidents")
	}
}

// checkEveryStatus: each value of the API's Status occurs as the status of
// some region in the edge data, so every status is read end to end.
func checkEveryStatus(t *testing.T, sum summary) {
	t.Helper()
	seen := map[string]bool{}
	for _, p := range sum.Products {
		for _, r := range p.Regions {
			seen[r.Status] = true
		}
	}
	for _, s := range statusValues(t) {
		if !seen[s] {
			t.Errorf("no region in the edge data has status %q; add one to testdata/contract-edge", s)
		}
	}
}

// statusValues reads the values of the Status schema in api/openapi.yaml.
func statusValues(t *testing.T) []string {
	t.Helper()
	raw, err := os.ReadFile("../../api/openapi.yaml")
	if err != nil {
		t.Fatal(err)
	}
	var doc struct {
		Components struct {
			Schemas struct {
				Status struct {
					Enum []string `yaml:"enum"`
				} `yaml:"Status"`
			} `yaml:"schemas"`
		} `yaml:"components"`
	}
	if err := yaml.Unmarshal(raw, &doc); err != nil {
		t.Fatal(err)
	}
	values := doc.Components.Schemas.Status.Enum
	if len(values) == 0 {
		t.Fatal("api/openapi.yaml: the Status schema has no enum")
	}
	return values
}

// checkEdgeSilentSibling: choreo-eu answers {} for components and incidents,
// choreo answers both. Choreo's regions keep their status and choreo-eu's
// read unknown. checkEdgeFeeds checks the product's checked_at and stale.
func checkEdgeSilentSibling(t *testing.T, p product) {
	t.Helper()
	want := map[string]string{
		"us-control-plane": "operational", "us-data-plane": "operational", "eu-data-plane-us-managed": "operational",
		"eu-control-plane": "unknown", "eu-data-plane": "unknown",
	}
	for _, r := range p.Regions {
		if want[r.ID] != r.Status {
			t.Errorf("developer-platform region %s = %s, want %s", r.ID, r.Status, want[r.ID])
		}
	}
	if len(p.Regions) != len(want) || p.DataComplete {
		t.Errorf("developer-platform: %d regions, data_complete %v; want %d and incomplete", len(p.Regions), p.DataComplete, len(want))
	}
}

// checkEdgeFeeds: in the edge data choreo-eu never answers components or
// incidents (it answers {}); everything else answers. Each never-answered
// kind is null in checked_at and stale; every other kind is checked and
// fresh.
func checkEdgeFeeds(t *testing.T, products map[string]product) {
	t.Helper()
	never := map[string]staleFlags{
		"developer-platform": {Components: true, Incidents: true},
	}
	for id, p := range products {
		want := never[id]
		got := staleFlags{Components: p.CheckedAt.Components == nil, Incidents: p.CheckedAt.Incidents == nil, Uptime: p.CheckedAt.Uptime == nil}
		if got != want || p.Stale != want {
			t.Errorf("%s: checked_at null for %+v and stale %+v, want both %+v", id, got, p.Stale, want)
		}
		if p.Outdated != (want.Incidents || want.Uptime) {
			t.Errorf("%s: outdated = %v, want %v", id, p.Outdated, want.Incidents || want.Uptime)
		}
	}
}

// checkEdgeMerge: choreo-eu answers {} for incidents while choreo has an
// open one. The open incident shows and raises the status; the history
// stays unknown until every source has answered.
func checkEdgeMerge(t *testing.T, p product) {
	t.Helper()
	found := false
	for _, inc := range p.Incidents {
		found = found || (inc.ID == "edge-choreo-active" && inc.ResolvedAt == nil)
	}
	if !found || p.Status != "outage" {
		t.Errorf("developer-platform: status %s, incidents %+v; want choreo's open outage shown and counted", p.Status, p.Incidents)
	}
	// No day reads quiet while choreo-eu has no incident data: a day shows
	// the incidents known for it, or is unknown. Today also holds choreo's
	// open outage.
	for i, d := range p.History {
		known := len(d.IncidentIDs) > 0
		if d.Status == "operational" || (known && d.Status == "unknown") || (!known && d.Status != "unknown" && i < len(p.History)-1) {
			t.Fatalf("day %s = %s with incidents %v, want unknown unless an incident is known for it", d.Date, d.Status, d.IncidentIDs)
		}
	}
	if today := p.History[len(p.History)-1]; today.Status != "outage" || !slices.Contains(today.IncidentIDs, "edge-choreo-active") {
		t.Errorf("today = %+v, want choreo's open outage", today)
	}
}

func shortHash(key string) string {
	sum := sha256.Sum256([]byte(key))
	return hex.EncodeToString(sum[:4])
}

func checkEdgeRegions(t *testing.T, p product) {
	t.Helper()
	want := []region{
		{ID: "us"}, {ID: "region"}, {ID: "ap-1-" + shortHash("AP 1")}, {ID: "ap-1-" + shortHash("ap-1")},
	}
	names := []string{"US", "--", "AP 1", "ap-1"}
	if len(p.Regions) != len(want) {
		t.Fatalf("moesif regions = %+v, want %d", p.Regions, len(want))
	}
	for i, r := range p.Regions {
		if r.ID != want[i].ID || p.RegionDetails[i].Name != names[i] {
			t.Errorf("region %d = %s %q, want %s %q", i, r.ID, p.RegionDetails[i].Name, want[i].ID, names[i])
		}
	}
}

func checkEdgeComponents(t *testing.T, p product) {
	t.Helper()
	unknown := 0
	for _, g := range p.RegionDetails[0].Groups {
		for _, c := range g.Components {
			if c.Status == "unknown" {
				unknown++
			}
		}
	}
	if unknown != 2 || p.DataComplete || p.Status != "operational" || p.Regions[0].Status != "operational" {
		t.Fatalf("moesif: %d unknown components, complete=%v, status=%s, us=%s; want 2, false, operational, operational",
			unknown, p.DataComplete, p.Status, p.Regions[0].Status)
	}
}

func checkEdgeIncident(t *testing.T, p product, sum summary) {
	t.Helper()
	var odd *incident
	for i, inc := range p.Incidents {
		if inc.ID == "edge-unknown-type" {
			odd = &p.Incidents[i]
		}
	}
	if odd == nil || odd.Impact != "unknown" || odd.ResolvedAt != nil {
		t.Fatalf("api-platform incident = %+v, want active with impact unknown", odd)
	}
	if severity[p.Status] < severity["degraded"] {
		t.Errorf("api-platform status = %s, want at least degraded", p.Status)
	}
	if today := p.History[len(p.History)-1]; today.Status != "degraded" || today.Minutes["degraded"] == 0 || today.Minutes["unknown"] != 0 {
		t.Errorf("api-platform today = %+v, want degraded minutes", today)
	}
	found := false
	for _, inc := range sum.ActiveIncidents {
		found = found || inc.ID == odd.ID
	}
	if !found {
		t.Error("the incident is missing from the summary's active incidents")
	}
}

// probe is one request, sent exactly as written.
type probe struct {
	method, path string
	headers      map[string]string
}

func (p probe) String() string {
	var sb strings.Builder
	sb.WriteString(p.method + " " + p.path)
	for _, k := range slices.Sorted(maps.Keys(p.headers)) {
		sb.WriteString(" [" + k + ": " + p.headers[k] + "]")
	}
	return sb.String()
}

// rawClient sends exactly the headers a probe names: no transparent gzip, no
// redirects followed.
var rawClient = func() *http.Client {
	tr := http.DefaultTransport.(*http.Transport).Clone()
	tr.DisableCompression = true
	return &http.Client{
		Timeout:       10 * time.Second,
		Transport:     tr,
		CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
	}
}()

func (p probe) send(t *testing.T, base string) response {
	t.Helper()
	req, err := http.NewRequestWithContext(t.Context(), p.method, base+p.path, nil)
	if err != nil {
		t.Fatal(err)
	}
	for k, v := range p.headers {
		req.Header.Set(k, v)
	}
	resp, err := rawClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = resp.Body.Close() }()
	body, err := io.ReadAll(resp.Body)
	if err != nil {
		t.Fatal(err)
	}
	return response{resp.StatusCode, resp.Header, body}
}

// decodedBody is the body as JSON when it is JSON, its text otherwise, and
// nil when there is none. A gzip body is decompressed first.
func decodedBody(t *testing.T, r response) any {
	t.Helper()
	body := r.body
	if r.header.Get("Content-Encoding") == "gzip" && len(body) > 0 {
		zr, err := gzip.NewReader(bytes.NewReader(body))
		if err != nil {
			t.Fatalf("gzip body: %v", err)
		}
		if body, err = io.ReadAll(zr); err != nil {
			t.Fatalf("gzip body: %v", err)
		}
	}
	if len(body) == 0 {
		return nil
	}
	var v any
	if err := json.Unmarshal(body, &v); err != nil {
		return string(body)
	}
	return v
}
