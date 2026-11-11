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
	"slices"
	"testing"
	"time"

	"github.com/wso2/wso2-cloud-status/backend/go/internal/domain"
	"github.com/wso2/wso2-cloud-status/backend/go/internal/source"
)

// TestIncidents: a product lists its active incidents and those of its
// history window, from all its sources, each once; one that ended before the
// window ("old", 30 days back with 7 history days) is left out of it, and
// kept in the incident list.
func TestIncidents(t *testing.T) {
	t.Parallel()
	st := freshState()
	shared := domain.Incident{ID: "shared", Impact: domain.StatusDegraded, StartedAt: t0.Add(-2 * time.Hour), ResolvedAt: resolved(t0.Add(-time.Hour))}
	active := domain.Incident{ID: "active", Impact: domain.StatusOutage, StartedAt: t0.Add(-30 * time.Minute)}
	old := domain.Incident{ID: "old", Impact: domain.StatusOutage, StartedAt: t0.AddDate(0, 0, -30), ResolvedAt: resolved(t0.AddDate(0, 0, -30).Add(time.Hour))}
	for key, items := range map[string][]domain.Incident{"b/s2": {shared, old}, "b/s3": {active, shared}} {
		s := st[key]
		s.incidents.data.Items = items
		st[key] = s
	}
	b := build(params(st, t0))
	two := b.Products["two"]
	if len(two.Incidents) != 2 || two.Incidents[0].ID != "active" || two.Incidents[0].ProductID != "two" {
		t.Fatalf("incidents = %+v", two.Incidents)
	}
	if two.Status != domain.StatusOutage || two.AffectedRegions != 0 {
		t.Fatalf("an active incident must raise the product status: %v affected=%d", two.Status, two.AffectedRegions)
	}
	if len(b.Summary.ActiveIncidents) != 1 || len(b.Incidents.Incidents) != 3 {
		t.Fatalf("active = %d, listed = %d; want 1 and every incident the sources keep (3)", len(b.Summary.ActiveIncidents), len(b.Incidents.Incidents))
	}
	if today := two.History[len(two.History)-1]; today.Status != domain.StatusOutage {
		t.Fatalf("today = %+v", today)
	}
}

// TestIncidentListHoldsEveryHistoryIncident: a product's own list keeps
// every incident that overlaps the history window, so every id a history day
// lists is in it: one that started before the window and ended inside it
// too. One that ended before the window, or exactly when it began, is left
// out of it. The incident list keeps every incident the sources hold.
func TestIncidentListHoldsEveryHistoryIncident(t *testing.T) {
	t.Parallel()
	windowStart := t0.Truncate(24*time.Hour).AddDate(0, 0, -6)
	st := freshState()
	s2 := st["b/s2"]
	s2.incidents.data.Items = []domain.Incident{
		{ID: "across", Impact: domain.StatusDegraded, StartedAt: windowStart.Add(-2 * time.Hour), ResolvedAt: resolved(windowStart.Add(time.Hour))},
		{ID: "before", Impact: domain.StatusDegraded, StartedAt: windowStart.Add(-3 * time.Hour), ResolvedAt: resolved(windowStart.Add(-time.Hour))},
		{ID: "until-start", Impact: domain.StatusOutage, StartedAt: windowStart.Add(-time.Hour), ResolvedAt: resolved(windowStart)},
		{ID: "instant", Impact: domain.StatusOutage, StartedAt: windowStart, ResolvedAt: resolved(windowStart)},
	}
	st["b/s2"] = s2
	b := build(params(st, t0))
	listed := map[string]bool{}
	for _, inc := range b.Incidents.Incidents {
		listed[inc.ID] = true
	}
	own := map[string]bool{}
	for _, inc := range b.Products["two"].Incidents {
		own[inc.ID] = true
	}
	referenced := map[string]bool{}
	for _, p := range b.Products {
		for _, d := range p.History {
			for _, id := range d.IncidentIDs {
				referenced[id] = true
				if !own[id] || !listed[id] {
					t.Errorf("%s history %s lists %s, which its own list or the incident list lacks", p.ID, d.Date, id)
				}
			}
		}
	}
	if !referenced["across"] || !referenced["instant"] || own["before"] || own["until-start"] {
		t.Fatalf("referenced %v, own %v; want across and instant in both, before and until-start in neither", referenced, own)
	}
	if len(listed) != 4 {
		t.Fatalf("listed %v, want all four", listed)
	}
}

// TestIncidentListSaysHowFarEachProductReaches: each product's coverage is
// its sources' latest coverage start, null while one has never answered for
// incidents, with the product's own incidents checked_at and stale.
func TestIncidentListSaysHowFarEachProductReaches(t *testing.T) {
	t.Parallel()
	st := freshState()
	s3 := st["b/s3"]
	s3.incidents.data.CoverageStart = t0.AddDate(0, -5, 0)
	st["b/s3"] = s3
	s1 := st["b/s1"]
	s1.incidents = fetched[source.Incidents]{}
	st["b/s1"] = s1
	b := build(params(st, t0))
	if len(b.Incidents.Products) != 2 {
		t.Fatalf("products = %+v", b.Incidents.Products)
	}
	one, two := b.Incidents.Products[0], b.Incidents.Products[1]
	if one.ID != "one" || one.CoveredFrom != nil || one.CheckedAt != nil || !one.Stale {
		t.Fatalf("one = %+v, want no coverage, never checked, stale", one)
	}
	want := t0.AddDate(0, -5, 0)
	if two.ID != "two" || two.Name != "Two" || two.CoveredFrom == nil || !two.CoveredFrom.Equal(want) || two.Stale {
		t.Fatalf("two = %+v, want covered from %s and current", two, want)
	}
	if two.CheckedAt == nil || !two.CheckedAt.Equal(*b.Products["two"].CheckedAt.Incidents) {
		t.Fatalf("two checked_at = %v, want the product's own", two.CheckedAt)
	}
}

// TestDuplicateIncidentsAreListedOnce: records of one product with the same
// title, impact and open or resolved state, whose starts and ends are each
// at most 60 s apart, are one incident, whichever source they come from and
// whatever order they arrive in; the smallest id is kept.
func TestDuplicateIncidentsAreListedOnce(t *testing.T) {
	t.Parallel()
	base := domain.Incident{
		ID: "m-first", Title: "Partial Degradation in Component Deployment", Impact: domain.StatusDegraded,
		StartedAt: t0.Add(-3 * time.Hour), ResolvedAt: resolved(t0.Add(-time.Hour)),
	}
	tests := []struct {
		name   string
		open   bool // both records still open
		source string
		edit   func(*domain.Incident)
		want   []string
	}{
		{"identical, larger id", false, "b/s2", func(i *domain.Incident) { i.ID = "z-second" }, []string{"m-first"}},
		{"identical, smaller id", false, "b/s2", func(i *domain.Incident) { i.ID = "a-second" }, []string{"a-second"}},
		{"identical, from the product's other source", false, "b/s3", func(i *domain.Incident) { i.ID = "a-second" }, []string{"a-second"}},
		{"identical and still open", true, "b/s2", func(i *domain.Incident) { i.ID = "z-second" }, []string{"m-first"}},
		{"start 60 s later", false, "b/s2", func(i *domain.Incident) { i.ID, i.StartedAt = "a-second", i.StartedAt.Add(time.Minute) }, []string{"a-second"}},
		{"start 60 s earlier, both open", true, "b/s2", func(i *domain.Incident) { i.ID, i.StartedAt = "z-second", i.StartedAt.Add(-time.Minute) }, []string{"m-first"}},
		{"end 60 s later", false, "b/s2", func(i *domain.Incident) { i.ID, i.ResolvedAt = "z-second", resolved(i.ResolvedAt.Add(time.Minute)) }, []string{"m-first"}},
		{"start 61 s later", false, "b/s2", func(i *domain.Incident) { i.ID, i.StartedAt = "z-second", i.StartedAt.Add(61*time.Second) }, []string{"z-second", "m-first"}},
		{"end 61 s earlier", false, "b/s2", func(i *domain.Incident) { i.ID, i.ResolvedAt = "z-second", resolved(i.ResolvedAt.Add(-61*time.Second)) }, []string{"m-first", "z-second"}},
		{"another title", false, "b/s2", func(i *domain.Incident) { i.ID, i.Title = "z-second", "Partial Degradation in Component Builds" }, []string{"m-first", "z-second"}},
		{"another impact", false, "b/s2", func(i *domain.Incident) { i.ID, i.Impact = "z-second", domain.StatusOutage }, []string{"m-first", "z-second"}},
		{"one still open", false, "b/s2", func(i *domain.Incident) { i.ID, i.ResolvedAt = "z-second", nil }, []string{"m-first", "z-second"}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			first := base
			if tt.open {
				first.ResolvedAt = nil
			}
			second := first
			tt.edit(&second)
			items := map[string][]domain.Incident{"b/s2": {second, first}}
			if tt.source != "b/s2" {
				items = map[string][]domain.Incident{"b/s2": {first}, tt.source: {second}}
			}
			checkIncidentIDs(t, items, tt.want)
		})
	}
}

// TestDuplicateIncidentsRealPair: the captured choreo history files one
// event of 17 Aug 2026 as two records 18 s apart at the start and 10 s at
// the end (testdata/upstream/choreo.incidents.json). They are one incident,
// under the smaller id.
func TestDuplicateIncidentsRealPair(t *testing.T) {
	t.Parallel()
	at := func(s string) time.Time {
		v, err := time.Parse(time.DateTime, s)
		if err != nil {
			t.Fatal(err)
		}
		return v
	}
	title := "Partial Degradation in New component creation & Component Builds"
	pair := []domain.Incident{
		{
			ID: "63221d8197728710182338f11153afc8", Title: title, Impact: domain.StatusDegraded, State: "resolved",
			StartedAt: at("2026-08-17 13:40:42"), ResolvedAt: resolved(at("2026-08-17 17:05:53")),
		},
		{
			ID: "563011cd97328710182338f11153affc", Title: title, Impact: domain.StatusDegraded, State: "resolved",
			StartedAt: at("2026-08-17 13:40:24"), ResolvedAt: resolved(at("2026-08-17 17:05:43")),
		},
	}
	if got := collapseDuplicates(pair); len(got) != 1 || got[0].ID != "563011cd97328710182338f11153affc" {
		t.Fatalf("collapsed = %v, want only 563011cd97328710182338f11153affc", got)
	}
}

// TestDuplicateIncidentsAreAFunctionOfTheirTimes: records chained within
// 60 s of each other are one event, whichever ids they carry. A chain at
// 0 s, 45 s and 90 s is one incident under its smallest id for every
// assignment of ids, and a record 200 s later is another.
func TestDuplicateIncidentsAreAFunctionOfTheirTimes(t *testing.T) {
	t.Parallel()
	open := func(id string, start time.Duration) domain.Incident {
		return domain.Incident{ID: id, Title: "Outage", Impact: domain.StatusOutage, StartedAt: t0.Add(-time.Hour + start)}
	}
	// Every id assignment, and every order the records can arrive in.
	for _, ids := range permutations([]string{"a", "b", "c", "d"}) {
		records := []domain.Incident{open(ids[0], 0), open(ids[1], 45*time.Second), open(ids[2], 90*time.Second), open(ids[3], 290*time.Second)}
		chain := slices.Min(ids[:3])
		for _, order := range permutations(records) {
			kept := []string{}
			for _, inc := range collapseDuplicates(order) {
				kept = append(kept, inc.ID)
			}
			if !slices.Equal(kept, []string{ids[3], chain}) {
				t.Fatalf("ids %v at 0, 45, 90 and 290 s, arriving as %v: kept %v, want %s then %s", ids, idsOf(order), kept, ids[3], chain)
			}
		}
	}
}

// TestSharedIDKeepsTheOpenCopy: when two sources of one product hold the
// same incident id, the open copy is kept whichever source holds it, and
// of two resolved copies the one that ends later.
func TestSharedIDKeepsTheOpenCopy(t *testing.T) {
	t.Parallel()
	start := t0.Add(-2 * time.Hour)
	open := domain.Incident{ID: "shared", Title: "Outage", Impact: domain.StatusOutage, StartedAt: start}
	early, late := open, open
	early.ResolvedAt, late.ResolvedAt = resolved(t0.Add(-time.Hour)), resolved(t0.Add(-time.Minute))
	tests := []struct {
		name   string
		s2, s3 domain.Incident
		want   *time.Time
	}{
		{"resolved first", early, open, nil},
		{"open first", open, early, nil},
		{"later end second", early, late, late.ResolvedAt},
		{"later end first", late, early, late.ResolvedAt},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			st := freshState()
			for key, inc := range map[string]domain.Incident{"b/s2": tt.s2, "b/s3": tt.s3} {
				s := st[key]
				s.incidents.data.Items = []domain.Incident{inc}
				st[key] = s
			}
			b := build(params(st, t0))
			listed := b.Products["two"].Incidents
			if len(listed) != 1 {
				t.Fatalf("two lists %d incidents, want 1", len(listed))
			}
			if got := listed[0].ResolvedAt; (got == nil) != (tt.want == nil) || got != nil && !got.Equal(*tt.want) {
				t.Errorf("kept the copy resolved at %v, want %v", got, tt.want)
			}
			wantStatus := domain.StatusOperational
			if tt.want == nil {
				wantStatus = domain.StatusOutage
			}
			if got := b.Products["two"].Status; got != wantStatus {
				t.Errorf("two is %v, want %v", got, wantStatus)
			}
		})
	}
}

// TestIncidentNotStartedYetIsLeftOut: an open incident whose start is ahead,
// by a second or by days, is in no view (no status, no active list, no
// history, no list) until its start, and then counts at once.
func TestIncidentNotStartedYetIsLeftOut(t *testing.T) {
	t.Parallel()
	for _, ahead := range []time.Duration{time.Second, 59 * time.Second, time.Minute, 48 * time.Hour} {
		t.Run(ahead.String(), func(t *testing.T) {
			t.Parallel()
			st := freshState()
			s1 := st["b/s1"]
			s1.incidents.data.Items = []domain.Incident{{
				ID: "ahead", Title: "Maintenance", Impact: domain.StatusMaintenance, State: "scheduled", StartedAt: t0.Add(ahead),
			}}
			st["b/s1"] = s1
			b := build(params(st, t0))
			one := b.Products["one"]
			if one.Status != domain.StatusOperational || one.ActiveIncidentCount != 0 || len(one.Incidents) != 0 ||
				len(b.Summary.ActiveIncidents) != 0 || len(b.Incidents.Incidents) != 0 || b.Summary.Status != domain.StatusOperational {
				t.Fatalf("before its start: status %v, count %d, listed %d, summary %v with %d active, list %d",
					one.Status, one.ActiveIncidentCount, len(one.Incidents), b.Summary.Status, len(b.Summary.ActiveIncidents), len(b.Incidents.Incidents))
			}
			for _, d := range one.History {
				if d.IncidentIDs != nil || d.Status != domain.StatusOperational {
					t.Fatalf("before its start: day %s = %+v, want operational with no incidents", d.Date, d)
				}
			}
			b = build(params(st, t0.Add(ahead)))
			if one := b.Products["one"]; one.Status != domain.StatusMaintenance || len(b.Summary.ActiveIncidents) != 1 {
				t.Fatalf("at its start: status %v, %d active", one.Status, len(b.Summary.ActiveIncidents))
			}
		})
	}
}

// permutations returns every ordering of s.
func permutations[T any](s []T) [][]T {
	if len(s) <= 1 {
		return [][]T{slices.Clone(s)}
	}
	var out [][]T
	for i := range s {
		for _, rest := range permutations(slices.Concat(s[:i:i], s[i+1:])) {
			out = append(out, append([]T{s[i]}, rest...))
		}
	}
	return out
}

// checkIncidentIDs builds with the given incidents per source and checks
// product two's incidents, and that its history refers to those only.
func checkIncidentIDs(t *testing.T, items map[string][]domain.Incident, want []string) {
	t.Helper()
	st := freshState()
	for key, list := range items {
		s := st[key]
		s.incidents.data.Items = list
		st[key] = s
	}
	two := build(params(st, t0)).Products["two"]
	got := make([]string, 0, len(two.Incidents))
	for _, inc := range two.Incidents {
		got = append(got, inc.ID)
	}
	if !slices.Equal(got, want) {
		t.Fatalf("incidents = %v, want %v", got, want)
	}
	var referenced []string
	for _, d := range two.History {
		referenced = append(referenced, d.IncidentIDs...)
	}
	slices.Sort(referenced)
	if wantSorted := slices.Sorted(slices.Values(want)); !slices.Equal(slices.Compact(referenced), wantSorted) {
		t.Fatalf("history refers to %v, want %v", referenced, wantSorted)
	}
}

func TestIdenticalIncidentsOfTwoProductsAreBothListed(t *testing.T) {
	t.Parallel()
	st := freshState()
	inc := domain.Incident{ID: "open", Title: "Outage", Impact: domain.StatusOutage, StartedAt: t0.Add(-time.Hour)}
	twin := inc
	twin.ID = "twin"
	for key, item := range map[string]domain.Incident{"b/s1": inc, "b/s2": twin} {
		s := st[key]
		s.incidents.data.Items = []domain.Incident{item}
		st[key] = s
	}
	b := build(params(st, t0))
	if len(b.Products["one"].Incidents) != 1 || len(b.Products["two"].Incidents) != 1 || len(b.Summary.ActiveIncidents) != 2 {
		t.Fatalf("one %v, two %v, active %v: identical records of two products are two incidents",
			b.Products["one"].Incidents, b.Products["two"].Incidents, b.Summary.ActiveIncidents)
	}
}
