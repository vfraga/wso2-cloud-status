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
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
	"time"

	"github.com/wso2/wso2-cloud-status/backend/go/internal/config"
	"github.com/wso2/wso2-cloud-status/backend/go/internal/domain"
	"github.com/wso2/wso2-cloud-status/backend/go/internal/source"
	"github.com/wso2/wso2-cloud-status/backend/go/internal/testutil"
)

// fixtureDir holds responses captured from the real public API on 2026-10-20,
// shared with the contract harness.
var fixtureDir = testutil.RepoPath("testdata", "upstream")

// fixtureServer serves <fixtureDir>/<cloud>.<endpoint>.json.
func fixtureServer(t *testing.T) *httptest.Server {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		endpoint := strings.TrimPrefix(r.URL.Path, "/api/v1/")
		name := filepath.Join(fixtureDir, r.URL.Query().Get("cloud")+"."+endpoint+".json")
		body, err := os.ReadFile(filepath.Clean(name))
		if err != nil {
			http.NotFound(w, r)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write(body)
	}))
	t.Cleanup(srv.Close)
	return srv
}

func newTestClient(t *testing.T, baseURL string, loc *time.Location) *Client {
	t.Helper()
	c, err := NewClient(baseURL, &http.Client{Timeout: 2 * time.Second}, loc, "statusd-test")
	if err != nil {
		t.Fatalf("NewClient: %v", err)
	}
	return c
}

func TestSourceReadsEveryCapturedCloud(t *testing.T) {
	t.Parallel()
	srv := fixtureServer(t)
	client := newTestClient(t, srv.URL, time.UTC)
	tests := []struct {
		cloud      string
		regions    int
		components int
		incidents  int
	}{
		{"agent-manager", 2, 18, 0},
		{"asgardeo", 2, 12, 1},
		{"bijira", 4, 30, 1},
		{"choreo", 3, 26, 15},
		{"choreo-eu", 2, 17, 0},
		{"devant", 4, 36, 1},
		{"moesif", 1, 11, 4},
	}
	for _, tt := range tests {
		t.Run(tt.cloud, func(t *testing.T) {
			t.Parallel()
			src := NewSource(client, tt.cloud)
			assertComponents(t, src, tt.regions, tt.components)
			assertUptime(t, src, tt.regions)
			assertIncidents(t, src, tt.incidents)
		})
	}
}

func assertComponents(t *testing.T, src *Source, regions, components int) {
	t.Helper()
	got, err := src.Components(context.Background())
	if err != nil {
		t.Fatalf("Components: %v", err)
	}
	if len(got) != regions {
		t.Fatalf("regions = %d, want %d", len(got), regions)
	}
	n := 0
	for _, groups := range got {
		for _, g := range groups {
			if g.Status != domain.StatusOperational {
				t.Fatalf("group %q status = %v, want operational in the capture", g.Name, g.Status)
			}
			n += len(g.Components)
		}
	}
	if n != components {
		t.Fatalf("components = %d, want %d", n, components)
	}
}

func assertUptime(t *testing.T, src *Source, regions int) {
	t.Helper()
	got, err := src.Uptime(context.Background())
	if err != nil {
		t.Fatalf("Uptime: %v", err)
	}
	if len(got) != regions {
		t.Fatalf("uptime regions = %d, want %d", len(got), regions)
	}
	for region, windows := range got {
		if len(windows) == 0 {
			t.Fatalf("region %q has no uptime windows", region)
		}
		for _, w := range windows {
			if w.Percent < 0 || w.Percent > 100 {
				t.Fatalf("region %q window %q percent %v out of range", region, w.Window, w.Percent)
			}
		}
	}
}

func assertIncidents(t *testing.T, src *Source, want int) {
	t.Helper()
	got, err := src.Incidents(context.Background())
	if err != nil {
		t.Fatalf("Incidents: %v", err)
	}
	if len(got.Items) != want {
		t.Fatalf("incidents = %d, want %d", len(got.Items), want)
	}
	if wantStart := time.Date(2026, 5, 1, 0, 0, 0, 0, time.UTC); !got.CoverageStart.Equal(wantStart) {
		t.Fatalf("coverage start = %v, want %v", got.CoverageStart, wantStart)
	}
	for i, inc := range got.Items {
		if i > 0 && inc.StartedAt.After(got.Items[i-1].StartedAt) {
			t.Fatal("incidents are not sorted newest first")
		}
		if inc.Active() || inc.ResolvedAt.Before(inc.StartedAt) || !inc.Impact.Known() {
			t.Fatalf("incident %s = %+v, want resolved with end after start and a known impact", inc.ID, inc)
		}
	}
}

func TestStatusCodeMapping(t *testing.T) {
	t.Parallel()
	want := map[int]domain.Status{
		0: domain.StatusOperational, 1: domain.StatusMaintenance,
		2: domain.StatusDegraded, 3: domain.StatusOutage, 7: domain.StatusUnknown, -1: domain.StatusUnknown,
	}
	for code, status := range want {
		if got := statusFromCode(&code); got != status {
			t.Fatalf("statusFromCode(%d) = %v, want %v", code, got, status)
		}
	}
	if got := statusFromCode(nil); got != domain.StatusUnknown {
		t.Fatalf("statusFromCode(nil) = %v, want unknown", got)
	}
}

func TestMissingOrNullComponentStatusIsUnknown(t *testing.T) {
	t.Parallel()
	srv := serveJSON(t, http.StatusOK, `{"us":[{"display_name":"G","subgroups":[
		{"display_name":"null","status":null},{"display_name":"absent"},{"display_name":"ok","status":0}]}]}`)
	got, err := NewSource(newTestClient(t, srv.URL, nil), "c").Components(context.Background())
	if err != nil {
		t.Fatalf("Components: %v", err)
	}
	g := got["us"][0]
	if g.Components[0].Status != domain.StatusUnknown || g.Components[1].Status != domain.StatusUnknown || g.Components[2].Status != domain.StatusOperational {
		t.Fatalf("components = %+v, want unknown, unknown, operational", g.Components)
	}
	if g.Status != domain.StatusOperational {
		t.Fatalf("group status = %v; unknown components are skipped in the roll-up", g.Status)
	}
}

func TestEmptyResponseIsAFailedFetch(t *testing.T) {
	t.Parallel()
	for _, body := range []string{"{}", "null", " null\n"} {
		srv := serveJSON(t, http.StatusOK, body)
		src := NewSource(newTestClient(t, srv.URL, nil), "c")
		for name, call := range map[string]func(*Source) error{"components": componentsCall, "uptime": uptimeCall, "incidents": incidentsCall} {
			if err := call(src); !errors.Is(err, ErrEmptyResponse) {
				t.Errorf("%s with body %q: err = %v, want ErrEmptyResponse", name, body, err)
			}
		}
	}
}

func TestWindowNames(t *testing.T) {
	t.Parallel()
	want := map[string]string{"Last 7 days": "7d", " Last 12 months ": "12mo", "Last 2 weeks": "last 2 weeks"}
	for in, out := range want {
		if got := window(in); got != out {
			t.Fatalf("window(%q) = %q, want %q", in, got, out)
		}
	}
}

func serveJSON(t *testing.T, status int, body string) *httptest.Server {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(status)
		_, _ = w.Write([]byte(body))
	}))
	t.Cleanup(srv.Close)
	return srv
}

func TestIncidentTimesAreReadInTheConfiguredZone(t *testing.T) {
	t.Parallel()
	colombo, err := time.LoadLocation("Asia/Colombo")
	if err != nil {
		t.Skipf("tzdata unavailable: %v", err)
	}
	srv := serveJSON(t, http.StatusOK, `{"2026-9":{"incidents":[{"id":"x","begin":"2026-09-01 07:06:28","end":"2026-09-01 07:23:00","type":"Outage","status":"Resolved","short_description":" Disruption "}]}}`)
	got, err := NewSource(newTestClient(t, srv.URL, colombo), "c").Incidents(context.Background())
	if err != nil {
		t.Fatalf("Incidents: %v", err)
	}
	inc := got.Items[0]
	if want := time.Date(2026, 9, 1, 1, 36, 28, 0, time.UTC); !inc.StartedAt.Equal(want) {
		t.Fatalf("started = %v, want %v", inc.StartedAt, want)
	}
	if inc.Title != "Disruption" || inc.Impact != domain.StatusOutage || inc.State != "resolved" {
		t.Fatalf("incident = %+v", inc)
	}
	if want := time.Date(2026, 8, 31, 18, 30, 0, 0, time.UTC); !got.CoverageStart.Equal(want) {
		t.Fatalf("coverage start = %v, want %v", got.CoverageStart, want)
	}
}

func TestIncidentLifecycleEdges(t *testing.T) {
	t.Parallel()
	srv := serveJSON(t, http.StatusOK, `{"2026-10":{"incidents":[
		{"id":"open","begin":"2026-10-20 10:00:00","end":null,"type":"Degraded","status":"Investigating","short_description":"a"},
		{"id":"no-end","begin":"2026-10-19 10:00:00","end":"","type":"Maintenance","status":"Resolved","short_description":"b"},
		{"id":"odd","begin":"2026-10-18 10:00:00","end":"2026-10-18 11:00:00","type":"Mystery","status":"Resolved","short_description":"c"},
		{"id":"backwards","begin":"2026-10-17 10:00:00","end":"2026-10-17 09:00:00","type":"Outage","status":"Resolved","short_description":"d"}]}}`)
	got, err := NewSource(newTestClient(t, srv.URL, nil), "c").Incidents(context.Background())
	if err != nil {
		t.Fatalf("Incidents: %v", err)
	}
	byID := map[string]domain.Incident{}
	for _, inc := range got.Items {
		byID[inc.ID] = inc
	}
	if !byID["open"].Active() || byID["open"].State != "investigating" {
		t.Fatalf("open = %+v, want active and investigating", byID["open"])
	}
	if noEnd := byID["no-end"]; noEnd.Active() || !noEnd.ResolvedAt.Equal(noEnd.StartedAt) || noEnd.Impact != domain.StatusMaintenance {
		t.Fatalf("no-end = %+v, want zero-length maintenance", noEnd)
	}
	if byID["odd"].Impact != domain.StatusUnknown {
		t.Fatalf("odd impact = %v, want unknown", byID["odd"].Impact)
	}
	// An end before the begin cannot be the end: zero-length at the begin, so the day it began still shows it.
	if b := byID["backwards"]; b.Active() || !b.ResolvedAt.Equal(b.StartedAt) {
		t.Fatalf("backwards = %+v, want zero-length at its begin", b)
	}
}

// TestEndTimeResolves: an incident with an end time is resolved at that
// time whatever its status word, so a contradictory record never reads as
// an ongoing incident.
func TestEndTimeResolves(t *testing.T) {
	t.Parallel()
	srv := serveJSON(t, http.StatusOK, `{"2026-10":{"incidents":[
		{"id":"null","begin":"2026-10-20 10:00:00","end":"2026-10-20 11:00:00","type":"Outage","status":null},
		{"id":"closed","begin":"2026-10-19 10:00:00","end":"2026-10-19 11:00:00","type":"Outage","status":"Closed"},
		{"id":"in-progress","begin":"2026-10-18 10:00:00","end":"2026-10-18 11:00:00","type":"Outage","status":"In Progress"}]}}`)
	got, err := NewSource(newTestClient(t, srv.URL, nil), "c").Incidents(context.Background())
	if err != nil {
		t.Fatalf("Incidents: %v", err)
	}
	for _, inc := range got.Items {
		if inc.Active() || !inc.ResolvedAt.Equal(inc.StartedAt.Add(time.Hour)) {
			t.Errorf("%s: resolved at %v, want an hour after its start", inc.ID, inc.ResolvedAt)
		}
	}
}

// TestRepeatedIncidentIDIsOneIncident: a record listed twice in one answer
// (under two months, say) is one incident, whichever month holds which
// copy: the open copy over a resolved one, else the one that ends later.
func TestRepeatedIncidentIDIsOneIncident(t *testing.T) {
	t.Parallel()
	const (
		open  = `{"id":"a","begin":"2026-09-30 00:00:00","type":"Outage","status":"Investigating"}`
		early = `{"id":"a","begin":"2026-09-30 00:00:00","end":"2026-09-30 01:00:00","type":"Outage","status":"Resolved"}`
		late  = `{"id":"a","begin":"2026-09-30 00:00:00","end":"2026-10-01 01:00:00","type":"Outage","status":"Resolved"}`
	)
	const milder = `{"id":"a","begin":"2026-09-30 00:00:00","type":"Degraded","status":"Investigating"}`
	tests := []struct {
		name, sept, oct string
		wantEnd         *time.Time
		wantImpact      domain.Status
	}{
		{"open in the later month", early, open, nil, domain.StatusOutage},
		{"open in the earlier month", open, early, nil, domain.StatusOutage},
		{"later end in the later month", early, late, new(time.Date(2026, 10, 1, 1, 0, 0, 0, time.UTC)), domain.StatusOutage},
		{"later end in the earlier month", late, early, new(time.Date(2026, 10, 1, 1, 0, 0, 0, time.UTC)), domain.StatusOutage},
		{"two open copies, the worse in the earlier month", open, milder, nil, domain.StatusOutage},
		{"two open copies, the worse in the later month", milder, open, nil, domain.StatusOutage},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			body := `{"2026-9":{"incidents":[` + tt.sept + `]},"2026-10":{"incidents":[` + tt.oct + `]}}`
			got, err := NewSource(newTestClient(t, serveJSON(t, http.StatusOK, body).URL, nil), "c").Incidents(t.Context())
			if err != nil {
				t.Fatal(err)
			}
			if len(got.Items) != 1 {
				t.Fatalf("%d incidents, want 1", len(got.Items))
			}
			if end := got.Items[0].ResolvedAt; (end == nil) != (tt.wantEnd == nil) || end != nil && !end.Equal(*tt.wantEnd) {
				t.Errorf("resolved at %v, want %v", end, tt.wantEnd)
			}
			if impact := got.Items[0].Impact; impact != tt.wantImpact {
				t.Errorf("impact %v, want %v", impact, tt.wantImpact)
			}
		})
	}
}

func TestMalformedUpstreamDataFails(t *testing.T) {
	t.Parallel()
	tests := []struct {
		name string
		body string
		call func(*Source) error
	}{
		{"bad begin", `{"2026-10":{"incidents":[{"id":"x","begin":"yesterday","status":"Resolved"}]}}`, incidentsCall},
		{"bad end", `{"2026-10":{"incidents":[{"id":"x","begin":"2026-10-01 00:00:00","end":"soon","status":"Resolved"}]}}`, incidentsCall},
		{"bad month key", `{"October":{"incidents":[]}}`, incidentsCall},
		{"no id", `{"2026-10":{"incidents":[{"begin":"2026-10-01 00:00:00","status":"Investigating"}]}}`, incidentsCall},
		{"blank id", `{"2026-10":{"incidents":[{"id":" ","begin":"2026-10-01 00:00:00","status":"Investigating"}]}}`, incidentsCall},
		{"not json", `<html>`, componentsCall},
		// A value of the wrong JSON type fails the fetch, so the last good
		// data stays and goes stale: types change for a whole backend.
		{"component status as text", `{"us":[{"display_name":"G","subgroups":[{"display_name":"C","status":"0"}]}]}`, componentsCall},
		{"subgroups as an object", `{"us":[{"display_name":"G","subgroups":{}}]}`, componentsCall},
		{"uptime not json", `<html>`, uptimeCall},
		{"uptime duration as a number", `{"us":[{"availability":"99.5","duration":7}]}`, uptimeCall},
		// A time JSON cannot encode would stop every product's snapshot.
		{"begin before 2000", `{"2026-10":{"incidents":[{"id":"x","begin":"0001-01-01 00:00:00","status":"Investigating"}]}}`, incidentsCall},
		{"end in 2100", `{"2026-10":{"incidents":[{"id":"x","begin":"2026-10-01 00:00:00","end":"2100-01-01 00:00:00","status":"Resolved"}]}}`, incidentsCall},
		{"month before 2000", `{"1999-12":{"incidents":[]}}`, incidentsCall},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			srv := serveJSON(t, http.StatusOK, tt.body)
			if err := tt.call(NewSource(newTestClient(t, srv.URL, nil), "c")); err == nil {
				t.Fatal("expected an error")
			}
		})
	}
}

// TestAnswerLimits: an answer at each limit is read, and one above it fails
// like a malformed one, whatever kind it is.
func TestAnswerLimits(t *testing.T) {
	t.Parallel()
	long := strings.Repeat("\u00e9", MaxText) // runes, not bytes, are counted
	tests := []struct {
		name     string
		at, over string
		call     func(*Source) error
	}{
		{"incidents", incidentAnswer(MaxIncidents), incidentAnswer(MaxIncidents + 1), incidentsCall},
		{"monitors region keys", monitors(MaxRegions, 1, 1), monitors(MaxRegions+1, 1, 1), componentsCall},
		{"component groups", monitors(1, MaxGroups, 1), monitors(1, MaxGroups+1, 1), componentsCall},
		{"components", monitors(1, 1, MaxComponents), monitors(1, 1, MaxComponents+1), componentsCall},
		{"uptime region keys", uptime(MaxRegions, 1), uptime(MaxRegions+1, 1), uptimeCall},
		{"uptime figures", uptime(1, MaxFigures), uptime(1, MaxFigures+1), uptimeCall},
		{"title", titled(long), titled(long + "x"), incidentsCall},
		{"incident id", withID(strings.Repeat("a", MaxID)), withID(strings.Repeat("a", MaxID+1)), incidentsCall},
		{
			"component name", `{"us":[{"display_name":"G","subgroups":[{"display_name":"` + long + `","status":0}]}]}`,
			`{"us":[{"display_name":"G","subgroups":[{"display_name":"` + long + `x","status":0}]}]}`, componentsCall,
		},
		{
			"region key", `{"` + long + `":[{"availability":"99.5","duration":"Last 7 days"}]}`,
			`{"` + long + `x":[{"availability":"99.5","duration":"Last 7 days"}]}`, uptimeCall,
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			for body, wantErr := range map[string]bool{tt.at: false, tt.over: true} {
				srv := serveJSON(t, http.StatusOK, body)
				if err := tt.call(NewSource(newTestClient(t, srv.URL, nil), "c")); (err != nil) != wantErr {
					t.Errorf("err %v; want an error %v", err, wantErr)
				}
			}
		})
	}
}

// incidentAnswer is an incident answer with n records over two months.
func incidentAnswer(n int) string {
	var months [2][]string
	for i := range n {
		months[i%2] = append(months[i%2], fmt.Sprintf(
			`{"id":"i%d","begin":"2026-10-01 00:00:00","end":"2026-10-01 01:00:00","type":"Outage","status":"Resolved"}`, i))
	}
	return `{"2026-10":{"incidents":[` + strings.Join(months[0], ",") + `]},"2026-9":{"incidents":[` + strings.Join(months[1], ",") + `]}}`
}

func titled(title string) string {
	return `{"2026-10":{"incidents":[{"id":"x","begin":"2026-10-01 00:00:00","short_description":"` + title + `","status":"Investigating"}]}}`
}

func withID(id string) string {
	return `{"2026-10":{"incidents":[{"id":"` + id + `","begin":"2026-10-01 00:00:00","status":"Investigating"}]}}`
}

// monitors is a monitors answer with the given region keys, groups per
// region and components per group.
func monitors(regions, groups, components int) string {
	rs := make([]string, 0, regions)
	for r := range regions {
		gs := make([]string, 0, groups)
		for g := range groups {
			cs := make([]string, 0, components)
			for c := range components {
				cs = append(cs, fmt.Sprintf(`{"display_name":"c%d","status":0}`, c))
			}
			gs = append(gs, fmt.Sprintf(`{"display_name":"g%d","subgroups":[%s]}`, g, strings.Join(cs, ",")))
		}
		rs = append(rs, fmt.Sprintf(`"r%d":[%s]`, r, strings.Join(gs, ",")))
	}
	return "{" + strings.Join(rs, ",") + "}"
}

// uptime is an availabilities answer with the given region keys and figures per region.
func uptime(regions, figures int) string {
	rs := make([]string, 0, regions)
	for r := range regions {
		fs := make([]string, 0, figures)
		for range figures {
			fs = append(fs, `{"availability":"99.5","duration":"Last 7 days"}`)
		}
		rs = append(rs, fmt.Sprintf(`"r%d":[%s]`, r, strings.Join(fs, ",")))
	}
	return "{" + strings.Join(rs, ",") + "}"
}

// TestLimitsLeaveRoomAboveTheCapturedAnswers: every limit is at least ten
// times what the largest captured real answer holds, and every captured
// answer is under a tenth of maxBody, so a heavy stretch of real data is
// never rejected. TestOversizedAnswersFail checks that the cap is applied.
func TestLimitsLeaveRoomAboveTheCapturedAnswers(t *testing.T) {
	t.Parallel()
	names, err := filepath.Glob(filepath.Join(fixtureDir, "*.json"))
	if err != nil || len(names) == 0 {
		t.Fatalf("no captured answers in %s: %v", fixtureDir, err)
	}
	for _, name := range names {
		body, err := os.ReadFile(filepath.Clean(name))
		if err != nil {
			t.Fatal(err)
		}
		if 10*len(body) > maxBody {
			t.Errorf("%s: %d bytes, more than a tenth of the %d byte cap", name, len(body), maxBody)
		}
		var m measure
		switch {
		case strings.HasSuffix(name, ".monitors.json"):
			m = measureComponents(decode[map[string][]wireGroup](t, name, body))
		case strings.HasSuffix(name, ".availabilities.json"):
			m = measureUptime(decode[map[string][]wireAvailability](t, name, body))
		case strings.HasSuffix(name, ".incidents.json"):
			m = measureIncidents(decode[map[string]wireMonth](t, name, body))
		default:
			t.Fatalf("%s: unknown kind of answer", name)
		}
		for what, n := range m.counts {
			if 10*n > m.limit[what] {
				t.Errorf("%s: %d %s, more than a tenth of the limit %d", name, n, what, m.limit[what])
			}
		}
		if 10*m.longest > MaxText {
			t.Errorf("%s: a value of %d characters, more than a tenth of MaxText %d", name, m.longest, MaxText)
		}
		if 2*m.longestID > MaxID {
			t.Errorf("%s: an incident id of %d characters, more than half of MaxID %d", name, m.longestID, MaxID)
		}
	}
}

// TestOversizedAnswersFail: each reader stops at maxBody, so an answer
// longer than that fails even when it would decode. The padding sits inside
// a string value the decoder ignores: a decoder stops at the end of the
// first complete value, so padding after it would prove nothing. The same
// answer with little padding is read.
func TestOversizedAnswersFail(t *testing.T) {
	t.Parallel()
	figure := func(padding string) string {
		return `{"us":[{"availability":"99.5","duration":"Last 7 days","padding":"` + padding + `"}]}`
	}
	for name, read := range map[string]func(t *testing.T, padding string) error{
		"legacy": func(t *testing.T, padding string) error {
			return uptimeCall(NewSource(newTestClient(t, serveJSON(t, http.StatusOK, figure(padding)).URL, nil), "c"))
		},
		"csm": func(t *testing.T, padding string) error {
			f := newFakeCSM(t)
			f.answer = func(w http.ResponseWriter, _, cloud string) bool {
				_, _ = fmt.Fprintf(w, `{"result":{"code":0,"message":"success","cloud":%q,"data":%s}}`, cloud, figure(padding))
				return true
			}
			return uptimeCall(csmSource(t, f, "moesif"))
		},
		"token": func(t *testing.T, padding string) error {
			srv := serveJSON(t, http.StatusOK, `{"access_token":"x","token_type":"Bearer","expires_in":100,"padding":"`+padding+`"}`)
			u, err := url.Parse(srv.URL)
			if err != nil {
				t.Fatal(err)
			}
			_, err = newTokenSource(u, "id", "secret", srv.Client()).token(context.Background())
			return err
		},
	} {
		t.Run(name, func(t *testing.T) {
			t.Parallel()
			if err := read(t, strings.Repeat(" ", 1000)); err != nil {
				t.Fatalf("an answer well under the cap: %v", err)
			}
			if err := read(t, strings.Repeat(" ", maxBody+1000)); err == nil {
				t.Fatalf("an answer above the %d byte cap was read", maxBody)
			}
		})
	}
}

func decode[T any](t *testing.T, name string, body []byte) T {
	t.Helper()
	var v T
	if err := json.Unmarshal(body, &v); err != nil {
		t.Fatalf("%s: %v", name, err)
	}
	return v
}

func incidentsCall(s *Source) error {
	_, err := s.Incidents(context.Background())
	return err
}

func uptimeCall(s *Source) error {
	_, err := s.Uptime(context.Background())
	return err
}

func componentsCall(s *Source) error {
	_, err := s.Components(context.Background())
	return err
}

func TestPercentAcceptsStringAndNumber(t *testing.T) {
	t.Parallel()
	srv := serveJSON(t, http.StatusOK, `{"us":[{"availability":"99.5","duration":"Last 7 days"},{"availability":99.998,"duration":"Last 90 days"},{"availability":100,"duration":"Last 30 days"}]}`)
	got, err := NewSource(newTestClient(t, srv.URL, nil), "c").Uptime(context.Background())
	if err != nil {
		t.Fatalf("Uptime: %v", err)
	}
	want := []float64{99.5, 99.998, 100}
	for i, w := range got["us"] {
		if w.Percent != want[i] {
			t.Fatalf("window %d = %v, want %v", i, w.Percent, want[i])
		}
	}
}

// TestMalformedUptimeFigureDropsOnlyThatFigure: a figure that is not a
// percentage is dropped; the region's other figures and every other region
// stay, so one bad entry does not freeze the source's whole uptime feed.
func TestMalformedUptimeFigureDropsOnlyThatFigure(t *testing.T) {
	t.Parallel()
	srv := serveJSON(t, http.StatusOK, `{
		"us": [{"availability":null,"duration":"Last 7 days"},{"availability":"","duration":"Last 30 days"},
		       {"availability":"NaN","duration":"Last 90 days"},{"availability":100.5,"duration":"Last 12 months"},
		       {"availability":"99.9","duration":"Last 12 months"}],
		"eu": [{"availability":"n/a","duration":"Last 7 days"},{"availability":"0x1p-2","duration":"Last 30 days"},
		       {"availability":"1_0","duration":"Last 90 days"},{"availability":"+5","duration":"Last 12 months"}],
		"in": [{"availability":99.5,"duration":"Last 7 days"}]}`)
	got, err := NewSource(newTestClient(t, srv.URL, nil), "c").Uptime(context.Background())
	if err != nil {
		t.Fatalf("Uptime: %v", err)
	}
	if us := got["us"]; len(us) != 1 || us[0] != (domain.Uptime{Window: "12mo", Percent: 99.9}) {
		t.Errorf("us = %+v, want only 12mo 99.9", us)
	}
	if eu, in := got["eu"], got["in"]; len(eu) != 0 || len(in) != 1 || in[0].Percent != 99.5 {
		t.Errorf("eu = %+v, in = %+v; want none and 99.5", eu, in)
	}
}

func TestMalformedComponentUptimeKeepsStatus(t *testing.T) {
	t.Parallel()
	srv := serveJSON(t, http.StatusOK, `{"us":[{"display_name":"G","subgroups":[{"display_name":"C","status":2,"availability":[{"availability":"?","duration":"Last 30 days"}]}]}]}`)
	got, err := NewSource(newTestClient(t, srv.URL, nil), "c").Components(context.Background())
	if err != nil {
		t.Fatalf("Components: %v", err)
	}
	c := got["us"][0].Components[0]
	if c.Status != domain.StatusDegraded || c.Uptime != nil {
		t.Fatalf("component = %+v, want degraded with no uptime", c)
	}
}

func TestNon200IsAnError(t *testing.T) {
	t.Parallel()
	srv := serveJSON(t, http.StatusBadGateway, "upstream down")
	_, err := NewSource(newTestClient(t, srv.URL, nil), "c").Components(context.Background())
	if !errors.Is(err, ErrUnexpectedStatus) {
		t.Fatalf("err = %v, want ErrUnexpectedStatus", err)
	}
}

// requestIDForm is the X-Request-ID statusd sends upstream: 32 hex digits,
// as it gives its own requests.
var requestIDForm = regexp.MustCompile(`^[0-9a-f]{32}$`)

// Every request carries its own X-Request-ID, and the error about a failed
// one names it, so the failure can be found in the upstream's logs.
func TestFailedFetchNamesItsRequestID(t *testing.T) {
	t.Parallel()
	ids := make(chan string, 2)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		ids <- r.Header.Get("X-Request-ID")
		http.Error(w, "upstream down", http.StatusBadGateway)
	}))
	t.Cleanup(srv.Close)
	src := NewSource(newTestClient(t, srv.URL, nil), "c")
	seen := map[string]bool{}
	for range 2 {
		_, err := src.Components(context.Background())
		id := <-ids
		if !requestIDForm.MatchString(id) || seen[id] {
			t.Fatalf("X-Request-ID %q: want 32 hex digits, new on every request", id)
		}
		seen[id] = true
		if !errors.Is(err, ErrUnexpectedStatus) || !strings.HasSuffix(err.Error(), "(X-Request-ID "+id+")") {
			t.Fatalf("err = %v, want it to name X-Request-ID %s", err, id)
		}
	}
}

func TestContextCancellationStopsTheCall(t *testing.T) {
	t.Parallel()
	srv := fixtureServer(t)
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := NewSource(newTestClient(t, srv.URL, nil), "choreo").Components(ctx); err == nil {
		t.Fatal("expected an error from a cancelled context")
	}
}

func TestRequestShape(t *testing.T) {
	t.Parallel()
	var got *http.Request
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		got = r.Clone(context.Background())
		_, _ = w.Write([]byte(`{"us":[]}`))
	}))
	t.Cleanup(srv.Close)
	if _, err := NewSource(newTestClient(t, srv.URL+"/base", nil), "a b&c").Components(context.Background()); err != nil {
		t.Fatalf("Components: %v", err)
	}
	if got.URL.Path != "/base/api/v1/monitors" || got.URL.Query().Get("cloud") != "a b&c" {
		t.Fatalf("request = %s", got.URL)
	}
	if got.Header.Get("User-Agent") != "statusd-test" || got.Header.Get("Accept") != "application/json" {
		t.Fatalf("headers = %v", got.Header)
	}
}

func TestNewClientValidation(t *testing.T) {
	t.Parallel()
	hc := &http.Client{}
	if _, err := NewClient("ftp://x", hc, nil, ""); err == nil {
		t.Fatal("expected an error for a non-http scheme")
	}
	// Plain http only to a loopback host, as for every backend type.
	if _, err := NewClient("http://api.status.example.com", hc, nil, ""); err == nil || !strings.Contains(err.Error(), "http only on a loopback host") {
		t.Fatalf("plain http to a remote host: err = %v", err)
	}
	for _, local := range []string{"http://127.0.0.1:18090", "http://localhost:18090", "http://[::1]:18090"} {
		if _, err := NewClient(local, hc, nil, ""); err != nil {
			t.Fatalf("%s: %v", local, err)
		}
	}
	if _, err := NewClient("://bad", hc, nil, ""); err == nil {
		t.Fatal("expected a parse error")
	}
	if _, err := NewClient("https://x", nil, nil, ""); err == nil {
		t.Fatal("expected an error for a nil http client")
	}
	c, err := NewClient("https://x", hc, nil, "")
	if err != nil || c.location != time.UTC {
		t.Fatalf("NewClient defaults: %v, location %v", err, c.location)
	}
}

func TestUnreachableBackendIsAnError(t *testing.T) {
	t.Parallel()
	srv := httptest.NewServer(http.NotFoundHandler())
	url := srv.URL
	srv.Close()
	if _, err := NewSource(newTestClient(t, url, nil), "c").Uptime(context.Background()); err == nil {
		t.Fatal("expected a connection error")
	}
}

func TestProvider(t *testing.T) {
	t.Parallel()
	env := source.Env{HTTPClient: &http.Client{}, UserAgent: "t"}
	p, err := NewProvider("b", config.Backend{BaseURL: "https://x.test", Timezone: "UTC"}, env)
	if err != nil {
		t.Fatal(err)
	}
	if s, ok := p.Source("choreo").(*Source); !ok || s.cloud != "choreo" {
		t.Fatalf("Source = %#v", p.Source("choreo"))
	}
	for name, b := range map[string]config.Backend{
		"options":  {BaseURL: "https://x.test", Timezone: "UTC", Options: map[string]string{"token": "x"}},
		"timezone": {BaseURL: "https://x.test", Timezone: "Nowhere/Nope"},
		"base url": {BaseURL: "ftp://x.test", Timezone: "UTC"},
		"http":     {BaseURL: "http://x.test", Timezone: "UTC"},
	} {
		if _, err := NewProvider("b", b, env); err == nil {
			t.Errorf("%s: expected an error", name)
		}
	}
}

// TestIncidentOrderIsDeterministic guards ETag stability: incidents that
// start in the same second must come out in the same order on every fetch,
// or every poll changes the body. The captured Choreo data has such ties.
func TestIncidentOrderIsDeterministic(t *testing.T) {
	t.Parallel()
	src := NewSource(newTestClient(t, fixtureServer(t).URL, nil), "choreo")
	first, err := src.Incidents(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	ties := 0
	for i := 1; i < len(first.Items); i++ {
		if first.Items[i].StartedAt.Equal(first.Items[i-1].StartedAt) {
			ties++
		}
	}
	if ties == 0 {
		t.Fatal("positive control failed: the fixture has no tied start times, so this test proves nothing")
	}
	for range 30 {
		again, err := src.Incidents(context.Background())
		if err != nil {
			t.Fatal(err)
		}
		for i := range first.Items {
			if again.Items[i].ID != first.Items[i].ID {
				t.Fatalf("order changed between fetches at %d: %s vs %s", i, again.Items[i].ID, first.Items[i].ID)
			}
		}
	}
}
