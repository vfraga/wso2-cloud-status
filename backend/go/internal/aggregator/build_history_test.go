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
	"context"
	"slices"
	"testing"
	"time"
	_ "time/tzdata" // TestHistoryDaysAreUTCWhateverTheClock needs a zone with daylight saving time.

	"github.com/wso2/wso2-cloud-status/backend/go/internal/config"
	"github.com/wso2/wso2-cloud-status/backend/go/internal/domain"
	"github.com/wso2/wso2-cloud-status/backend/go/internal/source"
)

func TestHistoryUnknownUntilEverySourceAnswers(t *testing.T) {
	t.Parallel()
	st := freshState()
	s3 := st["b/s3"]
	s3.incidents = fetched[source.Incidents]{}
	st["b/s3"] = s3
	for _, d := range build(params(st, t0)).Products["two"].History {
		if d.Status != domain.StatusUnknown {
			t.Fatalf("day %s = %v, want unknown", d.Date, d.Status)
		}
	}
}

// TestStaleIncidentFeedEndsCoverage: once a source's incidents are stale,
// its product's history ends at that source's last success. Days after it
// are unknown, even with incidents from the product's other source; the day
// that contains it shows the incidents known for it, or unknown; earlier
// days stay as they were. The other product is not affected.
func TestStaleIncidentFeedEndsCoverage(t *testing.T) {
	t.Parallel()
	lastSuccess := time.Date(2026, 10, 18, 14, 5, 0, 0, time.UTC)
	tests := []struct {
		name     string
		incident *domain.Incident
		want     []domain.Status // Oct 14 to Oct 20
	}{
		{"no incidents known for the last day", nil, []domain.Status{op, op, op, op, unk, unk, unk}},
		{"an incident known for the last day", &domain.Incident{
			ID: "known", Impact: domain.StatusDegraded,
			StartedAt: time.Date(2026, 10, 18, 9, 0, 0, 0, time.UTC), ResolvedAt: resolved(time.Date(2026, 10, 18, 9, 30, 0, 0, time.UTC)),
		}, []domain.Status{op, op, op, op, deg, unk, unk}},
		{"an incident from the other source after the end", &domain.Incident{
			ID: "later", Impact: domain.StatusOutage, StartedAt: time.Date(2026, 10, 19, 9, 0, 0, 0, time.UTC),
		}, []domain.Status{op, op, op, op, unk, unk, unk}},
		{"a resolved incident from the other source after the end", &domain.Incident{
			ID: "later-resolved", Impact: domain.StatusOutage,
			StartedAt: time.Date(2026, 10, 19, 9, 0, 0, 0, time.UTC), ResolvedAt: resolved(time.Date(2026, 10, 19, 9, 30, 0, 0, time.UTC)),
		}, []domain.Status{op, op, op, op, unk, unk, unk}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			st := freshState()
			s2, s3 := st["b/s2"], st["b/s3"]
			s3.incidents.at = lastSuccess
			if tt.incident != nil {
				s2.incidents.data.Items = []domain.Incident{*tt.incident}
			}
			st["b/s2"], st["b/s3"] = s2, s3
			b := build(params(st, t0))
			if got := historyStatuses(b.Products["two"].History); !slices.Equal(got, tt.want) {
				t.Fatalf("two history = %v, want %v", got, tt.want)
			}
			if got := historyStatuses(b.Products["one"].History); !slices.Equal(got, []domain.Status{op, op, op, op, op, op, op}) {
				t.Fatalf("one history = %v, want every day operational", got)
			}
			for _, d := range b.Products["two"].History[5:] {
				if d.IncidentIDs != nil || d.Minutes != nil {
					t.Fatalf("day %s after the coverage end lists incidents: %+v", d.Date, d)
				}
			}
		})
	}
}

// TestStaleIncidentFeedCoverageFollowsTheOldest: with two stale sources,
// coverage ends at the older last success; within the budget, it does not
// end at all.
func TestStaleIncidentFeedCoverageFollowsTheOldest(t *testing.T) {
	t.Parallel()
	st := freshState()
	s2, s3 := st["b/s2"], st["b/s3"]
	s2.incidents.at = time.Date(2026, 10, 17, 10, 0, 0, 0, time.UTC)
	s3.incidents.at = time.Date(2026, 10, 18, 14, 5, 0, 0, time.UTC)
	st["b/s2"], st["b/s3"] = s2, s3
	if got := historyStatuses(build(params(st, t0)).Products["two"].History); !slices.Equal(got, []domain.Status{op, op, op, unk, unk, unk, unk}) {
		t.Fatalf("two sources stale: history = %v, want unknown from Oct 17", got)
	}
	s2.incidents.at, s3.incidents.at = t0.Add(-4*time.Minute), t0.Add(-5*time.Minute)
	st["b/s2"], st["b/s3"] = s2, s3
	if got := historyStatuses(build(params(st, t0)).Products["two"].History); !slices.Equal(got, []domain.Status{op, op, op, op, op, op, op}) {
		t.Fatalf("within the budget: history = %v, want every day operational", got)
	}
}

// TestCoverageAcrossSources: a product's incident history starts at the
// latest coverage start among its sources and ends at the last success of
// the oldest source whose incidents are stale, whichever order the sources
// are listed in; a fresh source does not end it.
func TestCoverageAcrossSources(t *testing.T) {
	t.Parallel()
	refs := testConfig().Products[1].Sources
	for name, order := range map[string][]config.SourceRef{"s2 first": {refs[0], refs[1]}, "s3 first": {refs[1], refs[0]}} {
		st := freshState()
		s2, s3 := st["b/s2"], st["b/s3"]
		s2.incidents.data.CoverageStart, s3.incidents.data.CoverageStart = t0.AddDate(0, 0, -3), t0.AddDate(0, 0, -5)
		s2.incidents.at, s3.incidents.at = t0.Add(-2*time.Hour), t0.Add(-time.Hour)
		st["b/s2"], st["b/s3"] = s2, s3
		prod := config.Product{ID: "two", Sources: order}
		coverage := coverageOf(st, prod)
		if !coverage.From.Equal(t0.AddDate(0, 0, -3)) || !coverage.Until.Equal(t0.Add(-2*time.Hour)) {
			t.Errorf("%s: coverage %v to %v, want from the later start %v to the older stale success %v",
				name, coverage.From, coverage.Until, t0.AddDate(0, 0, -3), t0.Add(-2*time.Hour))
		}
		s2.incidents.at = t0.Add(-time.Minute)
		st["b/s2"] = s2
		if coverage := coverageOf(st, prod); !coverage.Until.Equal(t0.Add(-time.Hour)) {
			t.Errorf("%s with s2 fresh: coverage ends %v, want s3's last success %v", name, coverage.Until, t0.Add(-time.Hour))
		}
	}
}

// coverageOf is the incident coverage a build at t0 gives prod.
func coverageOf(st map[string]sourceState, prod config.Product) domain.Coverage {
	p := params(st, t0)
	feed := feedOf(p.state, prod.Sources, p.now, p.stale.incidents, func(st sourceState) time.Time { return st.incidents.at })
	_, coverage := productIncidents(p, prod, feed)
	return coverage
}

// TestStaleIncidentFlagEndsHistory: today's history reads unknown exactly
// when stale.incidents is set, at every age around the incidents' budget,
// whatever the other kinds' budgets are.
func TestStaleIncidentFlagEndsHistory(t *testing.T) {
	t.Parallel()
	for _, age := range []time.Duration{4 * time.Minute, 5 * time.Minute, 5*time.Minute + time.Second, 6 * time.Minute, 11 * time.Minute, 16 * time.Minute, 2 * time.Hour} {
		st := freshState()
		for _, key := range []string{"b/s2", "b/s3"} {
			s := st[key]
			s.incidents.at = t0.Add(-age)
			st[key] = s
		}
		p := params(st, t0)
		p.stale = staleness{components: 10 * time.Minute, uptime: 15 * time.Minute, incidents: 5 * time.Minute}
		two := build(p).Products["two"]
		if today := two.History[len(two.History)-1].Status; two.Stale.Incidents != (today == unk) {
			t.Errorf("incidents %v old: stale.incidents = %v but today = %v", age, two.Stale.Incidents, today)
		}
	}
}

// TestStaleIncidentFeedBackFills: the coverage end is derived at every
// build, so the days fill in as soon as the source answers again.
func TestStaleIncidentFeedBackFills(t *testing.T) {
	t.Parallel()
	st := freshState()
	s3 := st["b/s3"]
	s3.incidents.at = t0.Add(-2 * time.Hour)
	st["b/s3"] = s3
	if today := build(params(st, t0)).Products["two"].History[6]; today.Status != domain.StatusUnknown {
		t.Fatalf("stale: today = %+v, want unknown", today)
	}
	s3.incidents.at = t0.Add(time.Minute)
	st["b/s3"] = s3
	b := build(params(st, t0.Add(time.Minute)))
	if got := historyStatuses(b.Products["two"].History); !slices.Equal(got, []domain.Status{op, op, op, op, op, op, op}) || b.Products["two"].Outdated {
		t.Fatalf("after the source answered: history = %v, outdated %v; want every day operational again", got, b.Products["two"].Outdated)
	}
}

// TestHistoryDaysAreUTCWhateverTheClock: with a clock in New York, UTC-5 at
// now and UTC-4 at the window's start, the history's days and the product's
// incident window are UTC days: the last day is now's UTC date, and the
// window starts at 00:00 UTC six days before it, not an hour earlier as the
// change of offset would make it in local time.
func TestHistoryDaysAreUTCWhateverTheClock(t *testing.T) {
	t.Parallel()
	newYork, err := time.LoadLocation("America/New_York")
	if err != nil {
		t.Fatal(err)
	}
	now := time.Date(2026, 11, 5, 3, 0, 0, 0, time.UTC).In(newYork)
	windowStart := time.Date(2026, 10, 30, 0, 0, 0, 0, time.UTC)
	bindings, raw := fakes()
	raw["b/s2"].set(func(f *fakeSource) {
		f.incidents = source.Incidents{CoverageStart: now.AddDate(0, -6, 0), Items: []domain.Incident{
			{ID: "before", Title: "Before", Impact: domain.StatusDegraded, StartedAt: windowStart.Add(-2 * time.Hour), ResolvedAt: resolved(windowStart.Add(-30 * time.Minute))},
			{ID: "across", Title: "Across", Impact: domain.StatusDegraded, StartedAt: windowStart.Add(-time.Hour), ResolvedAt: resolved(windowStart.Add(30 * time.Minute))},
		}}
	})
	rec := &recorder{}
	a, err := New(slowConfig(), bindings, Options{Publish: rec.publish, Clock: func() time.Time { return now }})
	if err != nil {
		t.Fatal(err)
	}
	a.RefreshAll(context.Background())
	b := rec.last()
	two := b.Products["two"]
	if first, last := two.History[0].Date, two.History[len(two.History)-1].Date; first != "2026-10-30" || last != "2026-11-05" {
		t.Fatalf("history from %s to %s, want 2026-10-30 to 2026-11-05", first, last)
	}
	if got := idsOf(two.Incidents); !slices.Equal(got, []string{"across"}) {
		t.Fatalf("two lists %v, want only across: before ended before 00:00 UTC on the window's first day", got)
	}
	if got := idsOf(b.Incidents.Incidents); !slices.Equal(got, []string{"across", "before"}) {
		t.Fatalf("incident list = %v, want both", got)
	}
}

const (
	op  = domain.StatusOperational
	deg = domain.StatusDegraded
	unk = domain.StatusUnknown
)

func historyStatuses(days []domain.Day) []domain.Status {
	out := make([]domain.Status, len(days))
	for i, d := range days {
		out[i] = d.Status
	}
	return out
}

// TestAnsweredSourcesIncidentsShowWhileAnotherHasNone: while one source has
// never answered, the other's incidents are listed and counted, and its open
// outage marks today; days with no known incident stay unknown, not quiet.
func TestAnsweredSourcesIncidentsShowWhileAnotherHasNone(t *testing.T) {
	t.Parallel()
	st := freshState()
	s2, s3 := st["b/s2"], st["b/s3"]
	s2.incidents.data.Items = []domain.Incident{{ID: "open", Impact: domain.StatusOutage, StartedAt: t0.Add(-time.Hour)}}
	s3.incidents = fetched[source.Incidents]{}
	st["b/s2"], st["b/s3"] = s2, s3
	b := build(params(st, t0))
	two := b.Products["two"]
	if len(two.Incidents) != 1 || two.Status != domain.StatusOutage || len(b.Summary.ActiveIncidents) != 1 {
		t.Fatalf("incidents = %+v, status = %v; want s2's open incident shown and counted", two.Incidents, two.Status)
	}
	if today := two.History[len(two.History)-1]; today.Status != domain.StatusOutage {
		t.Fatalf("today = %+v, want the known outage while s3 has not answered", today)
	}
	if yesterday := two.History[len(two.History)-2]; yesterday.Status != domain.StatusUnknown {
		t.Fatalf("yesterday = %+v, want unknown until s3 answers", yesterday)
	}
}

// TestTodayTakesTheCurrentRegionStatus: a region in outage before any
// incident is filed makes today an outage day, with no minutes or incident
// ids of its own; earlier days stay as their incidents left them.
func TestTodayTakesTheCurrentRegionStatus(t *testing.T) {
	t.Parallel()
	st := freshState()
	s1 := st["b/s1"]
	s1.components.data = source.Components{
		"us": {group(domain.StatusOperational, domain.StatusOperational)},
		"eu": {group(domain.StatusOutage, domain.StatusOutage)},
	}
	st["b/s1"] = s1
	one := build(params(st, t0)).Products["one"]
	today := one.History[len(one.History)-1]
	if one.Status != domain.StatusOutage || today.Status != domain.StatusOutage || today.Minutes != nil || today.IncidentIDs != nil {
		t.Fatalf("status %v, today = %+v; want an outage day with no minutes or incidents", one.Status, today)
	}
	if yesterday := one.History[len(one.History)-2]; yesterday.Status != domain.StatusOperational {
		t.Fatalf("yesterday = %+v, want operational", yesterday)
	}
}
