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
	"math"
	"slices"
	"time"
)

const day = 24 * time.Hour

// Coverage is the span a product's incident history is complete for. From
// is the earliest instant the sources hold incidents from. Until, when it is
// set and before now, is when the incident data stops: the last successful
// fetch of a source whose incident feed has gone stale. A zero Until means
// the history is complete up to now.
type Coverage struct {
	From, Until time.Time
}

// DailyHistory derives one Day per UTC calendar day for the `days` days that
// end on now's date, oldest first.
//
// A day takes the most severe impact among the incidents that overlap it and
// records how many minutes of each impact it saw, by EffectiveImpact. An open
// incident counts up to the start of now's minute, or of coverage.Until's once
// the incident data has stopped, so its minutes change when generated_at
// does, rather than at the second it started, and never run past the data;
// it marks today from midnight, with 0 minutes until the first has passed.
// A day with no incidents is operational only when
// coverage spans all of it (up to now for today): days that start after
// coverage.Until are unknown, because no incidents there means no data, not
// no downtime. A day that starts before coverage.From (one of the product's
// sources has never answered, or holds nothing that old) and the day that
// contains coverage.Until are partly covered: they take the impact of the
// incidents known for them, and are unknown when none are.
func DailyHistory(incidents []Incident, days int, coverage Coverage, now time.Time) []Day {
	now = now.UTC()
	today := now.Truncate(day)
	history := make([]Day, 0, max(days, 0))
	for i := days - 1; i >= 0; i-- {
		start := today.AddDate(0, 0, -i)
		history = append(history, dayStatus(incidents, start, coverage, now))
	}
	return history
}

// RaiseToday makes the last day, today, at least as severe as the current
// status when that is a problem: a region can be in outage before anyone
// files an incident, and today must not read quiet then. It never raises a
// day to operational, so a day without data stays unknown.
func RaiseToday(history []Day, current Status) {
	if len(history) == 0 || current <= StatusOperational {
		return
	}
	today := &history[len(history)-1]
	today.Status = Worst(today.Status, current)
}

// baseStatus is a day's status before its incidents: operational when
// coverage spans it, unknown when it is partly covered (incidents may still
// raise it). listed is false for a day after the coverage end, which lists
// no incidents. complete reports whether coverage runs up to now.
func baseStatus(start time.Time, coverage Coverage, complete bool) (status Status, listed bool) {
	switch {
	case !complete && start.After(coverage.Until):
		return StatusUnknown, false
	case start.Before(coverage.From):
		return StatusUnknown, true
	case complete, !start.Add(day).After(coverage.Until):
		return StatusOperational, true
	}
	return StatusUnknown, true
}

func dayStatus(incidents []Incident, start time.Time, coverage Coverage, now time.Time) Day {
	complete := coverage.Until.IsZero() || !coverage.Until.Before(now)
	known := now
	if !complete {
		known = coverage.Until
	}
	status, listed := baseStatus(start, coverage, complete)
	d := Day{Date: start.Format(time.DateOnly), Status: status}
	if !listed {
		return d
	}
	end := minTime(start.Add(day), now)
	spans := map[Status][]span{}
	for _, inc := range incidents {
		s, touches := clip(inc, start, end, known)
		if !touches {
			continue
		}
		impact := inc.EffectiveImpact()
		spans[impact] = append(spans[impact], s)
		d.Status = Worst(d.Status, impact)
		d.IncidentIDs = append(d.IncidentIDs, inc.ID)
	}
	if len(spans) > 0 {
		d.Minutes = make(map[Status]int, len(spans))
		for impact, ss := range spans {
			d.Minutes[impact] = int(math.Ceil(union(ss).Minutes()))
		}
	}
	return d
}

// span is a half-open interval [from, to).
type span struct{ from, to time.Time }

// clip returns the part of the incident inside [start, end) and whether it
// touches the window at all. An open incident runs until the start of the
// known instant's minute, and touches every day up to the one that holds
// known even before its first whole minute there, so a day never reads
// quiet while an incident is open. An incident that starts and ends at the
// same instant inside the window touches it with zero length.
func clip(inc Incident, start, end, known time.Time) (span, bool) {
	incEnd := maxTime(known.Truncate(time.Minute), inc.StartedAt)
	if inc.ResolvedAt != nil {
		incEnd = *inc.ResolvedAt
	}
	s := span{from: maxTime(inc.StartedAt, start), to: minTime(incEnd, end)}
	if s.to.After(s.from) {
		return s, true
	}
	if inc.ResolvedAt == nil {
		return span{from: s.from, to: s.from}, inc.StartedAt.Before(end) && !known.Before(start)
	}
	instant := inc.StartedAt.Equal(incEnd)
	inWindow := !inc.StartedAt.Before(start) && inc.StartedAt.Before(end)
	return span{from: inc.StartedAt, to: inc.StartedAt}, instant && inWindow
}

// union is the time the spans cover, counting overlaps once: two incidents
// over the same hour (or one recorded twice) are one hour of impact.
func union(spans []span) time.Duration {
	slices.SortFunc(spans, func(a, b span) int { return a.from.Compare(b.from) })
	var total time.Duration
	cur := spans[0]
	for _, s := range spans[1:] {
		if s.from.After(cur.to) {
			total += cur.to.Sub(cur.from)
			cur = s
			continue
		}
		cur.to = maxTime(cur.to, s.to)
	}
	return total + cur.to.Sub(cur.from)
}

func minTime(a, b time.Time) time.Time {
	if a.Before(b) {
		return a
	}
	return b
}

func maxTime(a, b time.Time) time.Time {
	if a.After(b) {
		return a
	}
	return b
}
