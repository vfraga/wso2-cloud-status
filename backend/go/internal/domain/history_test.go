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

package domain

import (
	"maps"
	"math/rand/v2"
	"slices"
	"testing"
	"time"
)

func at(s string) time.Time {
	t, err := time.Parse(time.DateTime, s)
	if err != nil {
		panic(err)
	}
	return t.UTC()
}

func ptr(t time.Time) *time.Time { return &t }

func TestDailyHistoryShapeAndOrder(t *testing.T) {
	t.Parallel()
	now := at("2026-10-20 12:00:00")
	got := DailyHistory(nil, 3, Coverage{From: at("2026-01-01 00:00:00")}, now)
	want := []string{"2026-10-18", "2026-10-19", "2026-10-20"}
	if len(got) != len(want) {
		t.Fatalf("len = %d, want %d", len(got), len(want))
	}
	for i, d := range got {
		if d.Date != want[i] || d.Status != StatusOperational || d.Minutes != nil {
			t.Fatalf("day %d = %+v, want %s operational with no minutes", i, d, want[i])
		}
	}
}

func TestDailyHistoryBeforeCoverageIsUnknown(t *testing.T) {
	t.Parallel()
	now := at("2026-10-20 12:00:00")
	got := DailyHistory(nil, 3, Coverage{From: at("2026-10-19 00:00:00")}, now)
	if got[0].Status != StatusUnknown || got[1].Status != StatusOperational {
		t.Fatalf("got %v %v, want unknown then operational", got[0].Status, got[1].Status)
	}
}

func TestDailyHistoryIncidentAcrossMidnight(t *testing.T) {
	t.Parallel()
	now := at("2026-10-20 12:00:00")
	inc := Incident{
		ID: "a", Impact: StatusOutage,
		StartedAt:  at("2026-10-18 23:30:00"),
		ResolvedAt: ptr(at("2026-10-19 00:45:00")),
	}
	got := DailyHistory([]Incident{inc}, 3, Coverage{}, now)
	if got[0].Status != StatusOutage || got[0].Minutes[StatusOutage] != 30 {
		t.Fatalf("day 0 = %+v, want outage for 30 minutes", got[0])
	}
	if got[1].Status != StatusOutage || got[1].Minutes[StatusOutage] != 45 {
		t.Fatalf("day 1 = %+v, want outage for 45 minutes", got[1])
	}
	if got[2].Status != StatusOperational {
		t.Fatalf("day 2 = %+v, want operational", got[2])
	}
}

func TestDailyHistoryWorstImpactWinsAndMinutesAccumulate(t *testing.T) {
	t.Parallel()
	now := at("2026-10-20 12:00:00")
	incs := []Incident{
		{ID: "d1", Impact: StatusDegraded, StartedAt: at("2026-10-20 01:00:00"), ResolvedAt: ptr(at("2026-10-20 01:10:00"))},
		{ID: "o1", Impact: StatusOutage, StartedAt: at("2026-10-20 02:00:00"), ResolvedAt: ptr(at("2026-10-20 02:00:30"))},
		{ID: "d2", Impact: StatusDegraded, StartedAt: at("2026-10-20 03:00:00"), ResolvedAt: ptr(at("2026-10-20 03:05:00"))},
	}
	d := DailyHistory(incs, 1, Coverage{}, now)[0]
	if d.Status != StatusOutage {
		t.Fatalf("status = %v, want outage", d.Status)
	}
	if d.Minutes[StatusDegraded] != 15 || d.Minutes[StatusOutage] != 1 {
		t.Fatalf("minutes = %v, want degraded 15 and outage 1 (rounded up)", d.Minutes)
	}
	if len(d.IncidentIDs) != 3 {
		t.Fatalf("incident ids = %v, want 3", d.IncidentIDs)
	}
}

func TestDailyHistoryOpenIncidentCountsToNow(t *testing.T) {
	t.Parallel()
	now := at("2026-10-20 12:00:00")
	inc := Incident{ID: "open", Impact: StatusDegraded, StartedAt: at("2026-10-20 11:00:00")}
	d := DailyHistory([]Incident{inc}, 1, Coverage{}, now)[0]
	if d.Minutes[StatusDegraded] != 60 {
		t.Fatalf("minutes = %v, want 60", d.Minutes)
	}
	if !inc.Active() {
		t.Fatal("an incident without a resolution time must be active")
	}
}

// TestDailyHistoryOpenIncidentMinutesMoveWithTheMinute: an open incident's
// minutes count to the start of now's minute, so they change when the minute
// does, not at the second the incident started; one that started within the
// current minute is listed at once, with 0 minutes.
func TestDailyHistoryOpenIncidentMinutesMoveWithTheMinute(t *testing.T) {
	t.Parallel()
	inc := Incident{ID: "open", Impact: StatusDegraded, StartedAt: at("2026-10-20 11:00:20")}
	minutes := func(now string) int {
		t.Helper()
		d := DailyHistory([]Incident{inc}, 1, Coverage{}, at(now))[0]
		if d.Status != StatusDegraded || !slices.Equal(d.IncidentIDs, []string{"open"}) {
			t.Fatalf("at %s: day = %+v, want degraded listing the open incident", now, d)
		}
		return d.Minutes[StatusDegraded]
	}
	for now, want := range map[string]int{
		"2026-10-20 12:00:00": 60, "2026-10-20 12:00:19": 60, "2026-10-20 12:00:21": 60, "2026-10-20 12:00:59": 60,
		"2026-10-20 12:01:00": 61, "2026-10-20 11:00:21": 0, "2026-10-20 11:00:59": 0,
	} {
		if got := minutes(now); got != want {
			t.Errorf("at %s: minutes = %d, want %d", now, got, want)
		}
	}
}

func TestDailyHistoryZeroLengthIncidentTouchesItsDay(t *testing.T) {
	t.Parallel()
	now := at("2026-10-20 12:00:00")
	instant := at("2026-10-19 08:00:00")
	inc := Incident{ID: "z", Impact: StatusDegraded, StartedAt: instant, ResolvedAt: ptr(instant)}
	got := DailyHistory([]Incident{inc}, 2, Coverage{}, now)
	if got[0].Status != StatusDegraded || got[0].Minutes[StatusDegraded] != 0 {
		t.Fatalf("day 0 = %+v, want degraded with 0 minutes", got[0])
	}
	if got[1].Status != StatusOperational {
		t.Fatalf("day 1 = %+v, want operational", got[1])
	}
}

func TestDailyHistoryNonPositiveDays(t *testing.T) {
	t.Parallel()
	if got := DailyHistory(nil, 0, Coverage{}, time.Now()); len(got) != 0 {
		t.Fatalf("len = %d, want 0", len(got))
	}
	if got := DailyHistory(nil, -1, Coverage{}, time.Now()); len(got) != 0 {
		t.Fatalf("len = %d, want 0", len(got))
	}
}

func TestSortIncidentsIsTotal(t *testing.T) {
	t.Parallel()
	same := at("2026-10-01 10:00:00")
	base := []Incident{
		{ID: "c", StartedAt: same},
		{ID: "a", StartedAt: same},
		{ID: "z", StartedAt: at("2026-10-02 10:00:00")},
		{ID: "b", StartedAt: same},
		{ID: "y", StartedAt: at("2026-09-01 10:00:00")},
	}
	want := []string{"z", "a", "b", "c", "y"}
	for i := range 50 {
		in := slices.Clone(base)
		rand.New(rand.NewPCG(uint64(i), 7)).Shuffle(len(in), func(a, b int) { in[a], in[b] = in[b], in[a] })
		SortIncidents(in)
		for j, inc := range in {
			if inc.ID != want[j] {
				t.Fatalf("shuffle %d: order %v, want %v", i, ids(in), want)
			}
		}
	}
}

func ids(incs []Incident) []string {
	out := make([]string, len(incs))
	for i, inc := range incs {
		out[i] = inc.ID
	}
	return out
}

func TestDailyHistoryCountsOverlappingTimeOnce(t *testing.T) {
	t.Parallel()
	now := at("2026-10-20 23:00:00")
	incs := []Incident{
		// The same event recorded twice (the upstream does this), and a
		// third incident overlapping the second half of it.
		{ID: "a", Impact: StatusDegraded, StartedAt: at("2026-10-20 10:00:00"), ResolvedAt: ptr(at("2026-10-20 11:00:00"))},
		{ID: "b", Impact: StatusDegraded, StartedAt: at("2026-10-20 10:00:00"), ResolvedAt: ptr(at("2026-10-20 11:00:00"))},
		{ID: "c", Impact: StatusDegraded, StartedAt: at("2026-10-20 10:30:00"), ResolvedAt: ptr(at("2026-10-20 11:30:00"))},
		{ID: "d", Impact: StatusDegraded, StartedAt: at("2026-10-20 14:00:00"), ResolvedAt: ptr(at("2026-10-20 14:10:00"))},
		{ID: "e", Impact: StatusOutage, StartedAt: at("2026-10-20 10:15:00"), ResolvedAt: ptr(at("2026-10-20 10:45:00"))},
	}
	d := DailyHistory(incs, 1, Coverage{}, now)[0]
	if d.Minutes[StatusDegraded] != 100 || d.Minutes[StatusOutage] != 30 {
		t.Fatalf("minutes = %v, want degraded 100 (10:00-11:30 plus 10 min) and outage 30", d.Minutes)
	}
	if len(d.IncidentIDs) != 5 || d.Status != StatusOutage {
		t.Fatalf("day = %+v", d)
	}
}

func TestDailyHistoryCountsUnknownImpactAsDegraded(t *testing.T) {
	t.Parallel()
	now := at("2026-10-20 12:00:00")
	inc := Incident{ID: "odd", Impact: StatusUnknown, StartedAt: at("2026-10-20 10:00:00"), ResolvedAt: ptr(at("2026-10-20 10:30:00"))}
	d := DailyHistory([]Incident{inc}, 1, Coverage{}, now)[0]
	if d.Status != StatusDegraded || d.Minutes[StatusDegraded] != 30 || len(d.Minutes) != 1 {
		t.Fatalf("day = %+v, want degraded for 30 minutes", d)
	}
}

// TestDailyHistoryCoverageEnd: when the incident data stops at Until, days
// that start after it are unknown, the day that contains it takes the
// incidents known for it (unknown when there are none), and the days before
// it are covered as usual.
func TestDailyHistoryCoverageEnd(t *testing.T) {
	t.Parallel()
	now := at("2026-10-20 12:00:00")
	until := at("2026-10-18 14:05:00")
	from := at("2026-01-01 00:00:00")
	quiet := DailyHistory(nil, 5, Coverage{From: from, Until: until}, now)
	want := []Status{StatusOperational, StatusOperational, StatusUnknown, StatusUnknown, StatusUnknown}
	for i, d := range quiet {
		if d.Status != want[i] {
			t.Fatalf("no incidents: day %s = %v, want %v (%v)", d.Date, d.Status, want[i], quiet)
		}
	}

	incs := []Incident{
		{ID: "before", Impact: StatusMaintenance, StartedAt: at("2026-10-17 10:00:00"), ResolvedAt: ptr(at("2026-10-17 11:00:00"))},
		{ID: "same-day", Impact: StatusDegraded, StartedAt: at("2026-10-18 09:00:00"), ResolvedAt: ptr(at("2026-10-18 09:30:00"))},
		{ID: "open", Impact: StatusOutage, StartedAt: at("2026-10-18 13:00:00")},
	}
	got := DailyHistory(incs, 5, Coverage{From: from, Until: until}, now)
	partial := got[2]
	if partial.Date != "2026-10-18" || partial.Status != StatusOutage || !slices.Equal(partial.IncidentIDs, []string{"same-day", "open"}) {
		t.Fatalf("partly covered day = %+v, want outage from the incidents known for it", partial)
	}
	if !maps.Equal(partial.Minutes, map[Status]int{StatusDegraded: 30, StatusOutage: 65}) {
		t.Fatalf("partly covered day minutes = %v, want the open incident counted to the coverage end (65), not to the end of the day", partial.Minutes)
	}
	if got[1].Status != StatusMaintenance {
		t.Fatalf("a covered day = %+v, want maintenance", got[1])
	}
	for _, d := range got[3:] {
		if d.Status != StatusUnknown || d.IncidentIDs != nil || d.Minutes != nil {
			t.Fatalf("day %s after the coverage end = %+v, want unknown with no incidents, even with one still open", d.Date, d)
		}
	}
}

// TestDailyHistoryOpenIncidentTodayStopsAtCoverageEnd: today, an open
// incident counts to the start of the coverage end's minute, not to now.
func TestDailyHistoryOpenIncidentTodayStopsAtCoverageEnd(t *testing.T) {
	t.Parallel()
	incs := []Incident{{ID: "open", Impact: StatusOutage, StartedAt: at("2026-10-23 17:31:18")}}
	coverage := Coverage{From: at("2026-01-01 00:00:00"), Until: at("2026-10-23 18:01:29")}
	today := DailyHistory(incs, 1, coverage, at("2026-10-23 18:04:45"))[0]
	if today.Status != StatusOutage || !maps.Equal(today.Minutes, map[Status]int{StatusOutage: 30}) {
		t.Fatalf("today = %+v, want outage for 30 minutes (17:31:18 to 18:01)", today)
	}
}

// TestDailyHistoryCoverageEndBoundaries: an end at or after now is complete
// coverage; an end at midnight leaves that whole day partly covered.
func TestDailyHistoryCoverageEndBoundaries(t *testing.T) {
	t.Parallel()
	now := at("2026-10-20 12:00:00")
	from := at("2026-01-01 00:00:00")
	for _, until := range []time.Time{now, now.Add(time.Minute)} {
		if today := DailyHistory(nil, 1, Coverage{From: from, Until: until}, now)[0]; today.Status != StatusOperational {
			t.Fatalf("until %v: today = %v, want operational", until, today.Status)
		}
	}
	got := DailyHistory(nil, 2, Coverage{From: from, Until: at("2026-10-20 00:00:00")}, now)
	if got[0].Status != StatusOperational || got[1].Status != StatusUnknown {
		t.Fatalf("until midnight: %v, want yesterday operational and today unknown", got)
	}
}

// TestDailyHistoryKnownIncidentBeforeCoverage: a day before the sources'
// coverage (one has never answered) takes the impact of an incident known
// for it, as a partly covered day does; a day with none stays unknown.
func TestDailyHistoryKnownIncidentBeforeCoverage(t *testing.T) {
	t.Parallel()
	now := at("2026-10-20 12:00:00")
	incs := []Incident{{ID: "known", Impact: StatusDegraded, StartedAt: at("2026-10-19 08:00:00"), ResolvedAt: ptr(at("2026-10-19 09:00:00"))}}
	got := DailyHistory(incs, 3, Coverage{From: now.Add(48 * time.Hour)}, now)
	if got[1].Status != StatusDegraded || !slices.Equal(got[1].IncidentIDs, []string{"known"}) || got[1].Minutes[StatusDegraded] != 60 {
		t.Fatalf("day with a known incident = %+v, want degraded for 60 minutes", got[1])
	}
	for _, d := range []Day{got[0], got[2]} {
		if d.Status != StatusUnknown || d.IncidentIDs != nil {
			t.Fatalf("day %s = %+v, want unknown", d.Date, d)
		}
	}
}

// TestRaiseToday: today takes the current status when it is a problem worse
// than its incidents; an operational or unknown current status changes
// nothing, so a day without data is never made quiet.
func TestRaiseToday(t *testing.T) {
	t.Parallel()
	days := func() []Day {
		return []Day{{Date: "2026-10-19", Status: StatusOperational}, {Date: "2026-10-20", Status: StatusDegraded, IncidentIDs: []string{"a"}}}
	}
	got := days()
	RaiseToday(got, StatusOutage)
	if got[1].Status != StatusOutage || !slices.Equal(got[1].IncidentIDs, []string{"a"}) || got[0].Status != StatusOperational {
		t.Fatalf("raised = %+v, want today outage with its incident kept and yesterday untouched", got)
	}
	got = days()
	RaiseToday(got, StatusMaintenance)
	if got[1].Status != StatusDegraded {
		t.Fatalf("today = %+v, want degraded kept over a milder current status", got[1])
	}
	unknown := []Day{{Date: "2026-10-20", Status: StatusUnknown}}
	for _, current := range []Status{StatusOperational, StatusUnknown} {
		RaiseToday(unknown, current)
		if unknown[0].Status != StatusUnknown {
			t.Fatalf("current %v made a day without data %v", current, unknown[0].Status)
		}
	}
	RaiseToday(nil, StatusOutage)
}
