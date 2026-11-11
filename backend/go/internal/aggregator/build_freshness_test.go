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

package aggregator

import (
	"encoding/json"
	"os"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/wso2/wso2-cloud-status/backend/go/internal/config"
	"github.com/wso2/wso2-cloud-status/backend/go/internal/config/configtest"
	"github.com/wso2/wso2-cloud-status/backend/go/internal/domain"
	"github.com/wso2/wso2-cloud-status/backend/go/internal/source"
	"github.com/wso2/wso2-cloud-status/backend/go/internal/testutil"
)

func TestStalenessPerKind(t *testing.T) {
	t.Parallel()
	got := stalenessOf(config.Polling{
		ComponentsInterval: 30 * time.Second, UptimeInterval: 5 * time.Minute, IncidentsInterval: 2 * time.Minute,
		StaleAfter: 5 * time.Minute,
	})
	if got.components != 5*time.Minute || got.uptime != 15*time.Minute || got.incidents != 6*time.Minute {
		t.Fatalf("staleness = %+v, want 5m, 15m, 6m: stale_after or three intervals, the longer", got)
	}
}

// TestStaleAndOutdated covers the per-kind flags: a kind is stale when any
// of the product's sources has never answered for it or answered longer ago
// than its staleness, and the product is outdated when its incidents or its
// uptime are stale.
func TestStaleAndOutdated(t *testing.T) {
	t.Parallel()
	shipped := stalenessOf(config.Polling{
		ComponentsInterval: 30 * time.Second, UptimeInterval: 5 * time.Minute, IncidentsInterval: 30 * time.Second,
		StaleAfter: 5 * time.Minute,
	})
	tests := []struct {
		name string
		edit func(*sourceState)
		want Stale
	}{
		{"fresh", func(*sourceState) {}, Stale{}},
		{"incidents at the limit", func(s *sourceState) { s.incidents.at = t0.Add(-5 * time.Minute) }, Stale{}},
		{"incidents past the limit", func(s *sourceState) { s.incidents.at = t0.Add(-5*time.Minute - time.Second) }, Stale{Incidents: true}},
		{"uptime ten minutes old", func(s *sourceState) { s.uptime.at = t0.Add(-10 * time.Minute) }, Stale{}},
		{"uptime past fifteen minutes", func(s *sourceState) { s.uptime.at = t0.Add(-16 * time.Minute) }, Stale{Uptime: true}},
		{"incidents never answered", func(s *sourceState) { s.incidents = fetched[source.Incidents]{} }, Stale{Incidents: true}},
		{"uptime never answered", func(s *sourceState) { s.uptime = fetched[source.Uptime]{} }, Stale{Uptime: true}},
		{"components past the limit", func(s *sourceState) { s.components.at = t0.Add(-time.Hour) }, Stale{Components: true}},
		{"components never answered", func(s *sourceState) { s.components = fetched[source.Components]{} }, Stale{Components: true}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			st := freshState()
			s3 := st["b/s3"]
			tt.edit(&s3)
			st["b/s3"] = s3
			p := params(st, t0)
			p.stale = shipped
			b := build(p)
			two, one := b.Products["two"], b.Products["one"]
			if two.Stale != tt.want || one.Stale != (Stale{}) {
				t.Fatalf("two stale = %+v, want %+v; one stale = %+v, want none", two.Stale, tt.want, one.Stale)
			}
			if want := tt.want.Incidents || tt.want.Uptime; two.Outdated != want || one.Outdated {
				t.Fatalf("two outdated = %v, want %v; one outdated = %v, want false", two.Outdated, want, one.Outdated)
			}
			if tt.want.Components == two.DataComplete {
				t.Fatalf("two data_complete = %v with stale components %v", two.DataComplete, tt.want.Components)
			}
			if two.Outdated && (len(two.Incidents) != 0 || two.Status != domain.StatusOperational) {
				t.Fatalf("being outdated must not change the status or the incidents: %+v", two.ProductSummary)
			}
		})
	}
}

// TestCheckedAt: per kind, the oldest last success among the product's
// sources, floored to the minute in UTC, and nil while any of them has never
// answered for that kind.
func TestCheckedAt(t *testing.T) {
	t.Parallel()
	st := freshState()
	s2, s3 := st["b/s2"], st["b/s3"]
	s2.components.at = t0.Add(-2*time.Minute + 15*time.Second)
	s3.components.at = t0.Add(-30 * time.Second)
	s2.incidents.at = t0.Add(-time.Second)
	s3.uptime = fetched[source.Uptime]{}
	st["b/s2"], st["b/s3"] = s2, s3
	b := build(params(st, t0.Add(59*time.Second+999*time.Millisecond)))
	two := b.Products["two"]
	if got := two.CheckedAt; !equalMinute(got.Components, t0.Add(-2*time.Minute)) || !equalMinute(got.Incidents, t0.Add(-time.Minute)) || got.Uptime != nil {
		t.Fatalf("two checked_at = %s, want components 11:58, incidents 11:59, uptime null", formatCheckedAt(got))
	}
	if got := b.Products["one"].CheckedAt; !equalMinute(got.Components, t0) || !equalMinute(got.Incidents, t0) || !equalMinute(got.Uptime, t0) {
		t.Fatalf("one checked_at = %s, want 12:00 for every kind", formatCheckedAt(got))
	}
	for _, at := range []time.Time{b.Summary.GeneratedAt, b.Products["one"].GeneratedAt, b.Incidents.GeneratedAt} {
		if !at.Equal(t0) || at.Location() != time.UTC {
			t.Fatalf("generated_at = %v, want %v: the build time floored to the minute, in UTC", at, t0)
		}
	}
	raw, err := json.Marshal(b.Products["two"].ProductSummary)
	if err != nil {
		t.Fatal(err)
	}
	if want := `"outdated":true,"checked_at":{"components":"2026-10-20T11:58:00Z","incidents":"2026-10-20T11:59:00Z","uptime":null},"stale":{"components":false,"incidents":false,"uptime":true},"locations":[],"regions"`; !strings.Contains(string(raw), want) {
		t.Fatalf("product JSON = %s\nwant it to contain %s", raw, want)
	}
}

// TestGeneratedAtFollowsTheClock: generated_at moves with the minute and only
// with it, in every view.
func TestGeneratedAtFollowsTheClock(t *testing.T) {
	t.Parallel()
	local := time.FixedZone("UTC+5", 5*3600)
	at := func(now time.Time) string {
		b := build(params(freshState(), now))
		raw, err := json.Marshal(b.Summary)
		if err != nil {
			t.Fatal(err)
		}
		if !b.Products["two"].GeneratedAt.Equal(b.Summary.GeneratedAt) || !b.Incidents.GeneratedAt.Equal(b.Summary.GeneratedAt) {
			t.Fatal("every view of one build must carry the same generated_at")
		}
		return string(raw)
	}
	first, sameMinute, nextMinute := at(t0.Add(time.Second)), at(t0.Add(59*time.Second).In(local)), at(t0.Add(time.Minute))
	if first != sameMinute {
		t.Fatalf("the same minute must encode to the same bytes:\n%s\n%s", first, sameMinute)
	}
	if first == nextMinute || !strings.Contains(nextMinute, `"data_complete":true,"generated_at":"2026-10-20T12:01:00Z","products"`) {
		t.Fatalf("the next minute must change the body:\n%s", nextMinute)
	}
}

// TestCheckedAtMovesWithTheMinute: within one minute a product keeps the
// checked_at it was first published with, however many fetches land, so the
// body changes once a minute; it moves at once when the product's stale
// flags change, when a kind gets its first answer, or when its sources
// change, and with the next minute in any case.
func TestCheckedAtMovesWithTheMinute(t *testing.T) {
	t.Parallel()
	st := freshState()
	setAt := func(key string, components, incidents time.Time) {
		s := st[key]
		s.components.at, s.incidents.at = components, incidents
		st[key] = s
	}
	setAt("b/s1", t0.Add(-50*time.Second), t0.Add(-50*time.Second))
	p := params(st, t0.Add(5*time.Second))
	first := build(p)
	want := first.Products["one"].CheckedAt
	if !equalMinute(want.Components, t0.Add(-time.Minute)) {
		t.Fatalf("first: one checked_at = %s, want components 11:59", formatCheckedAt(want))
	}

	// A fetch later in the same minute: held.
	setAt("b/s1", t0.Add(20*time.Second), t0.Add(20*time.Second))
	p.now, p.held = t0.Add(25*time.Second), first.held
	second := build(p)
	if got := second.Products["one"].CheckedAt; formatCheckedAt(got) != formatCheckedAt(want) || formatCheckedAt(second.Summary.Products[0].CheckedAt) != formatCheckedAt(want) {
		t.Fatalf("same minute: one checked_at = %s, want it held at %s in the summary and the product", formatCheckedAt(got), formatCheckedAt(want))
	}

	// The next minute: derived again.
	p.now, p.held = t0.Add(time.Minute+time.Second), second.held
	third := build(p)
	if got := third.Products["one"].CheckedAt; !equalMinute(got.Components, t0) || !equalMinute(got.Incidents, t0) {
		t.Fatalf("next minute: one checked_at = %s, want 12:00", formatCheckedAt(got))
	}

	// A stale flag that changes within the minute: derived again at once,
	// so the time agrees with the flag.
	setAt("b/s3", t0.Add(-4*time.Minute-50*time.Second), t0)
	p.now, p.held = t0.Add(time.Minute+5*time.Second), third.held
	fourth := build(p)
	setAt("b/s3", t0.Add(time.Minute+10*time.Second), t0)
	p.now, p.held = t0.Add(time.Minute+15*time.Second), fourth.held
	fifth := build(p)
	if !fourth.Products["two"].Stale.Components || fifth.Products["two"].Stale.Components ||
		!equalMinute(fifth.Products["two"].CheckedAt.Components, t0) {
		t.Fatalf("stale then fresh within a minute: stale %v then %v, checked_at %s; want true, false, components 12:00",
			fourth.Products["two"].Stale.Components, fifth.Products["two"].Stale.Components, formatCheckedAt(fifth.Products["two"].CheckedAt))
	}

	// A first answer within the minute: no longer null.
	s3 := st["b/s3"]
	s3.uptime = fetched[source.Uptime]{}
	st["b/s3"] = s3
	sixth := build(p)
	s3.uptime = fetched[source.Uptime]{data: source.Uptime{}, at: t0.Add(time.Minute + 20*time.Second)}
	st["b/s3"] = s3
	p.now, p.held = t0.Add(time.Minute+25*time.Second), sixth.held
	seventh := build(p)
	if got := seventh.Products["two"].CheckedAt.Uptime; sixth.Products["two"].CheckedAt.Uptime != nil || got == nil {
		t.Fatalf("first answer within the minute: uptime %v then %v, want null then a time", sixth.Products["two"].CheckedAt.Uptime, got)
	}

	// Different sources, with the same stale flags and null kinds: derived
	// again.
	setAt("b/s2", t0.Add(time.Minute+20*time.Second), t0)
	p.products = slices.Clone(p.products)
	p.products[1].Sources = p.products[1].Sources[:1]
	p.held = seventh.held
	held, eighth := seventh.Products["two"], build(p).Products["two"]
	if held.Stale != eighth.Stale || nullKinds(held.CheckedAt) != nullKinds(eighth.CheckedAt) {
		t.Fatalf("sources changed: stale %+v then %+v, checked_at %s then %s; want only the sources to differ",
			held.Stale, eighth.Stale, formatCheckedAt(held.CheckedAt), formatCheckedAt(eighth.CheckedAt))
	}
	if got := eighth.CheckedAt; !equalMinute(got.Components, t0.Add(time.Minute)) {
		t.Fatalf("sources changed: two checked_at = %s, want only s2's 12:01", formatCheckedAt(got))
	}
}

func equalMinute(got *time.Time, want time.Time) bool {
	return got != nil && got.Equal(want) && got.Location() == time.UTC
}

func formatCheckedAt(c CheckedAt) string {
	f := func(t *time.Time) string {
		if t == nil {
			return "null"
		}
		return t.Format(time.RFC3339Nano)
	}
	return "components " + f(c.Components) + ", incidents " + f(c.Incidents) + ", uptime " + f(c.Uptime)
}

func TestOutdatedKeepsShowingTheLastIncidents(t *testing.T) {
	t.Parallel()
	st := freshState()
	s2 := st["b/s2"]
	s2.incidents.data.Items = []domain.Incident{{ID: "open", Impact: domain.StatusOutage, StartedAt: t0.Add(-2 * time.Hour)}}
	s2.incidents.at = t0.Add(-time.Hour)
	st["b/s2"] = s2
	two := build(params(st, t0)).Products["two"]
	if !two.Outdated || two.Status != domain.StatusOutage || len(two.Incidents) != 1 {
		t.Fatalf("two = outdated %v, status %v, %d incidents; want outdated, still raised by the open incident", two.Outdated, two.Status, len(two.Incidents))
	}
}

// TestEmptyStateHasNoNulls: before any source answers, the only nulls in a
// body are checked_at values, where null means "never checked", and the
// incident list's covered_from, "never answered".
func TestEmptyStateHasNoNulls(t *testing.T) {
	t.Parallel()
	b := build(params(map[string]sourceState{"b/s1": {}, "b/s2": {}, "b/s3": {}}, t0))
	if b.Summary.Status != domain.StatusUnknown {
		t.Fatalf("status=%v", b.Summary.Status)
	}
	for _, v := range []any{b.Summary, b.Products["two"], b.Incidents} {
		raw, err := json.Marshal(v)
		if err != nil {
			t.Fatal(err)
		}
		var decoded any
		if err := json.Unmarshal(raw, &decoded); err != nil {
			t.Fatal(err)
		}
		for _, path := range nullPaths("$", decoded) {
			if !strings.Contains(path, ".checked_at") && !strings.HasSuffix(path, ".covered_from") {
				t.Fatalf("JSON has null at %s: %s", path, raw)
			}
		}
	}
}

// nullPaths lists the paths of every null in a decoded JSON value.
func nullPaths(path string, v any) []string {
	switch v := v.(type) {
	case nil:
		return []string{path}
	case map[string]any:
		var out []string
		for k, child := range v {
			out = append(out, nullPaths(path+"."+k, child)...)
		}
		return out
	case []any:
		var out []string
		for i, child := range v {
			out = append(out, nullPaths(path+"["+strconv.Itoa(i)+"]", child)...)
		}
		return out
	default:
		return nil
	}
}

// TestCopiesOfTheStalenessMatchTheShippedConfiguration: the alert rules and
// the external check hold the staleness budgets as fixed numbers, because
// they run where the configuration is not. They must equal what the shipped
// configuration gives (components and incidents 5 min, uptime 15 min, the
// page's limit stale_after), or alerts fire before or after the API calls
// data stale.
func TestCopiesOfTheStalenessMatchTheShippedConfiguration(t *testing.T) {
	t.Parallel()
	cfg := configtest.Load(t, testutil.RepoPath("config", "statusd.yaml"))
	limits := stalenessOf(cfg.Polling)
	read := func(path string) string {
		raw, err := os.ReadFile(path)
		if err != nil {
			t.Fatal(err)
		}
		return string(raw)
	}
	rules := read(testutil.RepoPath("deploy", "observability", "prometheus-rules.yaml"))
	if limits.components != limits.incidents {
		t.Fatalf("the rules give components and incidents one threshold; the configuration gives %s and %s", limits.components, limits.incidents)
	}
	for pattern, want := range map[string]time.Duration{
		`kind=~"components\|incidents"\} > (\d+)`: limits.components,
		`kind="uptime"\} > (\d+)`:                 limits.uptime,
		`kind="components"\} > (\d+)\)`:           limits.components,
	} {
		m := regexp.MustCompile(pattern).FindStringSubmatch(rules)
		if m == nil {
			t.Errorf("prometheus-rules.yaml: no match for %s", pattern)
			continue
		}
		if got, _ := strconv.Atoi(m[1]); time.Duration(got)*time.Second != want {
			t.Errorf("prometheus-rules.yaml %s: %s s, want %s", pattern, m[1], want)
		}
	}
	m := regexp.MustCompile(`MAX_AGE_SECONDS:-(\d+)`).FindStringSubmatch(read(testutil.RepoPath("scripts", "ops", "synthetic-check.sh")))
	if m == nil {
		t.Fatal("synthetic-check.sh: no default MAX_AGE_SECONDS")
	}
	if got, _ := strconv.Atoi(m[1]); time.Duration(got)*time.Second != cfg.Polling.StaleAfter {
		t.Errorf("synthetic-check.sh default MAX_AGE_SECONDS %s, want stale_after %s", m[1], cfg.Polling.StaleAfter)
	}
}
