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
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/wso2/wso2-cloud-status/backend/go/internal/config"
	"github.com/wso2/wso2-cloud-status/backend/go/internal/domain"
	"github.com/wso2/wso2-cloud-status/backend/go/internal/source"
	"github.com/wso2/wso2-cloud-status/backend/go/internal/source/legacyapi"
)

func TestAllHealthy(t *testing.T) {
	t.Parallel()
	b := build(params(freshState(), t0))
	if b.Summary.Status != domain.StatusOperational || !b.Summary.DataComplete || !b.Ready {
		t.Fatalf("summary = %v complete=%v ready=%v", b.Summary.Status, b.Summary.DataComplete, b.Ready)
	}
	for _, p := range b.Summary.Products {
		if p.Status != domain.StatusOperational || p.AffectedRegions != 0 || !p.DataComplete || p.Outdated || len(p.History) != 7 {
			t.Fatalf("product %s = %+v", p.ID, p)
		}
	}
}

// TestSummaryDataComplete: the summary's data is complete when every
// product's is and every product status is known. Outdated incidents or
// uptime do not make it incomplete.
func TestSummaryDataComplete(t *testing.T) {
	t.Parallel()
	tests := []struct {
		name string
		edit func(map[string]sourceState)
		want bool
	}{
		{"every product complete", func(map[string]sourceState) {}, true},
		{"one component unknown", func(st map[string]sourceState) {
			s1 := st["b/s1"]
			s1.components.data = source.Components{"us": {group(domain.StatusOperational, domain.StatusUnknown)}, "eu": {group(domain.StatusOperational)}}
			st["b/s1"] = s1
		}, false},
		{"one of a product's two sources stale", func(st map[string]sourceState) {
			s3 := st["b/s3"]
			s3.components.at = t0.Add(-time.Hour)
			st["b/s3"] = s3
		}, false},
		{"a product's only source never answered", func(st map[string]sourceState) {
			st["b/s1"] = sourceState{}
		}, false},
		{"incidents outdated", func(st map[string]sourceState) {
			s2 := st["b/s2"]
			s2.incidents.at = t0.Add(-time.Hour)
			st["b/s2"] = s2
		}, true},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			st := freshState()
			tt.edit(st)
			if got := build(params(st, t0)).Summary.DataComplete; got != tt.want {
				t.Fatalf("summary data_complete = %v, want %v", got, tt.want)
			}
		})
	}
	if allComplete(nil) {
		t.Fatal("no products must not read as complete data")
	}
}

// TestSummaryStatus: the overall status fails closed. Unknown when data is
// missing and no problem is known; otherwise the most severe known status,
// so a known problem leads even over missing data.
func TestSummaryStatus(t *testing.T) {
	t.Parallel()
	op, mt, dg, out, unk := domain.StatusOperational, domain.StatusMaintenance, domain.StatusDegraded, domain.StatusOutage, domain.StatusUnknown
	tests := []struct {
		products []domain.Status
		complete bool
		want     domain.Status
	}{
		{[]domain.Status{op, op}, true, op},
		{[]domain.Status{op, unk}, false, unk},
		{[]domain.Status{op, op}, false, unk},
		{[]domain.Status{unk, unk}, false, unk},
		{nil, false, unk},
		{[]domain.Status{mt, unk}, false, mt},
		{[]domain.Status{op, dg, unk}, false, dg},
		{[]domain.Status{out, dg}, true, out},
	}
	for _, tt := range tests {
		if got := failClosed(tt.products, tt.complete); got != tt.want {
			t.Errorf("failClosed(%v, complete=%v) = %v, want %v", tt.products, tt.complete, got, tt.want)
		}
	}

	// Through build: one product without data greys the summary, a degraded one leads it.
	st := freshState()
	st["b/s1"] = sourceState{}
	if got := build(params(st, t0)).Summary; got.Status != unk || got.DataComplete {
		t.Fatalf("one product without data: summary %v, data_complete %v; want unknown and false", got.Status, got.DataComplete)
	}
	s2 := st["b/s2"]
	s2.components.data = source.Components{"us": {group(domain.StatusDegraded)}}
	st["b/s2"] = s2
	if got := build(params(st, t0)).Summary.Status; got != dg {
		t.Fatalf("a degraded product beside one without data: summary %v, want degraded", got)
	}
}

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
	if got := build(p).Products["two"].CheckedAt.Uptime; sixth.Products["two"].CheckedAt.Uptime != nil || got == nil {
		t.Fatalf("first answer within the minute: uptime %v then %v, want null then a time", sixth.Products["two"].CheckedAt.Uptime, got)
	}

	// Different sources: derived again.
	setAt("b/s2", t0.Add(time.Minute+20*time.Second), t0)
	p.products = slices.Clone(p.products)
	p.products[1].Sources = p.products[1].Sources[:1]
	if got := build(p).Products["two"].CheckedAt; !equalMinute(got.Components, t0.Add(time.Minute)) {
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

func TestDegradedRegionRollsUp(t *testing.T) {
	t.Parallel()
	st := freshState()
	s1 := st["b/s1"]
	s1.components.data = source.Components{
		"us": {group(domain.StatusOperational, domain.StatusDegraded)},
		"eu": {group(domain.StatusOperational)},
	}
	st["b/s1"] = s1
	b := build(params(st, t0))
	one := b.Products["one"]
	if one.Status != domain.StatusDegraded || one.AffectedRegions != 1 || b.Summary.Status != domain.StatusDegraded {
		t.Fatalf("one = %v affected=%d overall=%v", one.Status, one.AffectedRegions, b.Summary.Status)
	}
	if one.Regions[0].Status != domain.StatusDegraded || one.Regions[1].Status != domain.StatusOperational {
		t.Fatalf("regions = %+v", one.Regions)
	}
}

func TestStaleDataNeverReadsHealthy(t *testing.T) {
	t.Parallel()
	b := build(params(freshState(), t0.Add(6*time.Minute)))
	one := b.Products["one"]
	if one.Status != domain.StatusUnknown || one.DataComplete || b.Summary.Status != domain.StatusUnknown {
		t.Fatalf("one = %v complete=%v overall=%v", one.Status, one.DataComplete, b.Summary.Status)
	}
	for _, g := range one.RegionDetails[0].Groups {
		for _, c := range g.Components {
			if c.Status != domain.StatusUnknown {
				t.Fatalf("component %s = %v, want unknown", c.Name, c.Status)
			}
		}
	}
	if st := freshState(); st["b/s1"].components.data["us"][0].Components[0].Status != domain.StatusOperational {
		t.Fatal("marking stale data unknown must not mutate stored state")
	}
}

func TestOneStaleSourceLeavesTheOtherVisible(t *testing.T) {
	t.Parallel()
	st := freshState()
	s3 := st["b/s3"]
	s3.components.at = t0.Add(-10 * time.Minute)
	st["b/s3"] = s3
	two := build(params(st, t0)).Products["two"]
	if two.Status != domain.StatusOperational || two.DataComplete {
		t.Fatalf("two = %v complete=%v, want operational and incomplete", two.Status, two.DataComplete)
	}
	if two.Regions[1].PageURL != "https://eu.two.test" || two.Regions[0].PageURL != "https://two.test" {
		t.Fatalf("page urls = %s, %s", two.Regions[0].PageURL, two.Regions[1].PageURL)
	}
}

func TestUnconfiguredRegionIsShown(t *testing.T) {
	t.Parallel()
	st := freshState()
	s1 := st["b/s1"]
	s1.components.data = healthy("us", "eu", "AP - South 1")
	st["b/s1"] = s1
	one := build(params(st, t0)).Products["one"]
	last := one.Regions[len(one.Regions)-1]
	if len(one.Regions) != 3 || last.ID != "ap-south-1" || last.Name != "AP - South 1" {
		t.Fatalf("regions = %+v", one.Regions)
	}
}

func shortHash(key string) string {
	sum := sha256.Sum256([]byte(key))
	return hex.EncodeToString(sum[:4])
}

func TestUnmatchedRegionIDsAreUniqueAndOrderFree(t *testing.T) {
	t.Parallel()
	st := freshState()
	s2, s3 := st["b/s2"], st["b/s3"]
	// "US CP" collides with the configured us-cp, "AP 1" and "ap-1" with each
	// other, "--" has no slug and is reported by both sources.
	s2.components.data = healthy("cp", "AP 1", "ap-1", "--", "US CP")
	s3.components.data = healthy("cp", "--", "new")
	st["b/s2"], st["b/s3"] = s2, s3
	two := build(params(st, t0)).Products["two"]
	want := []string{
		"us-cp", "region-" + shortHash("--"), "ap-1-" + shortHash("AP 1"), "us-cp-" + shortHash("US CP"), "ap-1-" + shortHash("ap-1"),
		"eu-cp", "region-" + shortHash("--") + "-2", "new",
	}
	got := make([]string, 0, len(two.Regions))
	for _, r := range two.Regions {
		got = append(got, r.ID)
	}
	if !slices.Equal(got, want) {
		t.Fatalf("region ids = %v\nwant %v", got, want)
	}
	if two.Regions[2].Name != "AP 1" || two.RegionDetails[2].ID != two.Regions[2].ID {
		t.Fatalf("an unmatched region keeps its key as its name: %+v", two.Regions[2])
	}
}

// TestSharedSourceShowsEachProductItsOwnRegions: two products that read one
// source with different region keys each show only their own regions; a key
// neither configures shows in both, as an unmatched region, and counts as
// unmatched once in the source's region keys.
func TestSharedSourceShowsEachProductItsOwnRegions(t *testing.T) {
	t.Parallel()
	products := []config.Product{
		{ID: "a", Name: "A", PageURL: "https://a.test", Sources: []config.SourceRef{
			{Backend: "b", Cloud: "x", Regions: []config.RegionRef{{Key: "us", ID: "us", Name: "US"}}},
		}},
		{ID: "b", Name: "B", PageURL: "https://b.test", Sources: []config.SourceRef{
			{Backend: "b", Cloud: "x", Regions: []config.RegionRef{{Key: "eu", ID: "eu", Name: "EU"}}},
		}},
	}
	st := map[string]sourceState{"b/x": freshState()["b/s1"]}
	shared := st["b/x"]
	shared.components.data = healthy("us", "eu", "ap")
	st["b/x"] = shared
	p := params(st, t0)
	p.products = products
	b := build(p)
	for id, want := range map[string][]string{"a": {"us", "ap"}, "b": {"eu", "ap"}} {
		var got []string
		for _, r := range b.Products[id].Regions {
			got = append(got, r.ID)
		}
		if !slices.Equal(got, want) {
			t.Errorf("product %s regions = %v, want %v", id, got, want)
		}
	}
	if got := b.RegionKeys["b/x"]; len(got.Missing) != 0 || !slices.Equal(got.Unmatched, []string{"ap"}) {
		t.Errorf("region keys = %+v, want only ap unmatched", got)
	}
}

// TestRegionKeys compares each answering source's keys with the configured
// ones: configured but not reported (missing), reported but not configured
// (unmatched). A source that has not answered is left out.
func TestRegionKeys(t *testing.T) {
	t.Parallel()
	st := freshState()
	s1 := st["b/s1"]
	s1.components.data = healthy("us", "AP 1", "--")
	st["b/s1"] = s1
	st["b/s3"] = sourceState{}
	got := build(params(st, t0)).RegionKeys
	want := map[string]RegionKeys{
		"b/s1": {Missing: []string{"eu"}, Unmatched: []string{"--", "AP 1"}},
		"b/s2": {},
	}
	if len(got) != len(want) {
		t.Fatalf("region keys = %+v, want %+v", got, want)
	}
	for key, w := range want {
		if g := got[key]; !slices.Equal(g.Missing, w.Missing) || !slices.Equal(g.Unmatched, w.Unmatched) {
			t.Fatalf("%s: %+v, want %+v", key, g, w)
		}
	}
}

func TestUnknownComponentMakesDataIncomplete(t *testing.T) {
	t.Parallel()
	st := freshState()
	s1 := st["b/s1"]
	s1.components.data = source.Components{
		"us": {group(domain.StatusOperational, domain.StatusUnknown)},
		"eu": {group(domain.StatusOperational)},
	}
	st["b/s1"] = s1
	one := build(params(st, t0)).Products["one"]
	if one.Status != domain.StatusOperational || one.Regions[0].Status != domain.StatusOperational || one.DataComplete {
		t.Fatalf("one = %v, us = %v, complete = %v; want operational, operational, incomplete", one.Status, one.Regions[0].Status, one.DataComplete)
	}
}

func TestUnknownImpactCountsAsDegraded(t *testing.T) {
	t.Parallel()
	st := freshState()
	s2 := st["b/s2"]
	s2.incidents.data.Items = []domain.Incident{{ID: "odd", Impact: domain.StatusUnknown, StartedAt: t0.Add(-time.Hour)}}
	st["b/s2"] = s2
	two := build(params(st, t0)).Products["two"]
	if two.Status != domain.StatusDegraded || two.Incidents[0].Impact != domain.StatusUnknown {
		t.Fatalf("status = %v, incident impact = %v; want degraded, and the incident's own impact unknown", two.Status, two.Incidents[0].Impact)
	}
	if today := two.History[len(two.History)-1]; today.Status != domain.StatusDegraded || today.Minutes[domain.StatusDegraded] != 60 {
		t.Fatalf("today = %+v, want degraded for 60 minutes", today)
	}
}

func TestMissingRegionIsUnknown(t *testing.T) {
	t.Parallel()
	st := freshState()
	s1 := st["b/s1"]
	s1.components.data = healthy("us")
	st["b/s1"] = s1
	one := build(params(st, t0)).Products["one"]
	if one.Regions[1].Status != domain.StatusUnknown || one.DataComplete {
		t.Fatalf("eu = %v complete=%v", one.Regions[1].Status, one.DataComplete)
	}
}

func resolved(at time.Time) *time.Time { return &at }

// TestIncidents: a product lists its active incidents and those of its
// history window, from all its sources, each once; one that ended before the
// window ("old", 30 days back with 7 history days) is left out.
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
	if len(b.Summary.ActiveIncidents) != 1 || len(b.Incidents.Incidents) != 2 {
		t.Fatalf("active = %d, window = %d", len(b.Summary.ActiveIncidents), len(b.Incidents.Incidents))
	}
	if today := two.History[len(two.History)-1]; today.Status != domain.StatusOutage {
		t.Fatalf("today = %+v", today)
	}
}

// TestIncidentListHoldsEveryHistoryIncident: the incident list, and each
// product's own list, keep every incident that overlaps the history window,
// so every id a history day lists is in them: one that started before the
// window and ended inside it too. One that ended before the window, or
// exactly when it began, is left out of both.
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
	for id, p := range b.Products {
		for _, inc := range p.Incidents {
			if !listed[inc.ID] {
				t.Errorf("product %s lists %s, which the incident list lacks", id, inc.ID)
			}
		}
	}
	referenced := map[string]bool{}
	for _, p := range b.Summary.Products {
		for _, d := range p.History {
			for _, id := range d.IncidentIDs {
				referenced[id] = true
				if !listed[id] {
					t.Errorf("%s history %s lists %s, which the incident list lacks", p.ID, d.Date, id)
				}
			}
		}
	}
	if !referenced["across"] || !referenced["instant"] || listed["before"] || listed["until-start"] {
		t.Fatalf("referenced %v, listed %v; want across and instant in both, before and until-start in neither", referenced, listed)
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

// TestIncidentCollapseAtTheCapIsCheap: a build where every source holds as
// many incident records as one answer may (legacyapi.MaxIncidents), all of
// one event or all of distinct events, takes far less than a poll interval.
// It runs alone, not in parallel, so its time is its own.
func TestIncidentCollapseAtTheCapIsCheap(t *testing.T) {
	const budget = 2 * time.Second
	n := legacyapi.MaxIncidents
	for _, tt := range []struct {
		name    string
		spacing time.Duration
		want    int
	}{{"one event", 0, 1}, {"distinct events", 2 * collapseWindow, n}} {
		st := freshState()
		for _, key := range []string{"b/s1", "b/s2", "b/s3"} {
			items := make([]domain.Incident, n)
			for i := range items {
				start := t0.Add(-48*time.Hour + time.Duration(i)*tt.spacing)
				items[i] = domain.Incident{
					ID: fmt.Sprintf("%s-%d", key, i), Title: "Outage", Impact: domain.StatusOutage,
					StartedAt: start, ResolvedAt: resolved(start.Add(time.Hour)),
				}
			}
			s := st[key]
			s.incidents.data.Items = items
			st[key] = s
		}
		start := time.Now()
		b := build(params(st, t0))
		took := time.Since(start)
		t.Logf("%s: %d records per source built in %v", tt.name, n, took)
		if one, two := len(b.Products["one"].Incidents), len(b.Products["two"].Incidents); one != tt.want || two != tt.want {
			t.Errorf("%s: one lists %d incidents, two lists %d; want %d each", tt.name, one, two, tt.want)
		}
		if took > budget {
			t.Errorf("%s: build took %v, want under %v", tt.name, took, budget)
		}
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

func idsOf(incidents []domain.Incident) []string {
	out := make([]string, len(incidents))
	for i, inc := range incidents {
		out[i] = inc.ID
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

// TestEmptyStateIsNotReadyAndHasNoNulls: before any source answers, the
// only nulls in a body are checked_at values, where null means "never
// checked".
func TestEmptyStateIsNotReadyAndHasNoNulls(t *testing.T) {
	t.Parallel()
	b := build(params(map[string]sourceState{"b/s1": {}, "b/s2": {}, "b/s3": {}}, t0))
	if b.Ready || b.Summary.Status != domain.StatusUnknown {
		t.Fatalf("ready=%v status=%v", b.Ready, b.Summary.Status)
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
			if !strings.Contains(path, ".checked_at.") {
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

// locatedProduct has two locations whose regions come from two sources,
// listed out of order, as Developer Platform's are: the US-managed EU data
// plane is read from the US cloud.
func locatedProduct() config.Product {
	return config.Product{ID: "three", Name: "Three", PageURL: "https://three.test", Sources: []config.SourceRef{
		{Backend: "b", Cloud: "s4", Regions: []config.RegionRef{
			{Key: "dp", ID: "us-dp", Name: "US data plane", Location: "US"},
			{Key: "cp", ID: "us-cp", Name: "US control plane", Location: "US"},
			{Key: "eu-dp", ID: "eu-dp-us", Name: "EU data plane (US-managed)", Location: "EU"},
		}},
		{Backend: "b", Cloud: "s5", PageURL: "https://eu.three.test", Regions: []config.RegionRef{
			{Key: "cp", ID: "eu-cp", Name: "EU control plane", Location: "EU"},
			{Key: "dp", ID: "eu-dp", Name: "EU data plane", Location: "EU"},
		}},
	}}
}

func locatedState() map[string]sourceState {
	st := freshState()
	up := fetched[source.Uptime]{data: source.Uptime{
		"cp": {{Window: "90d", Percent: 99.994}}, "dp": {{Window: "90d", Percent: 100}}, "eu-dp": {{Window: "90d", Percent: 99.993}},
	}, at: t0}
	st["b/s4"] = sourceState{components: fetched[source.Components]{data: healthy("dp", "cp", "eu-dp"), at: t0}, uptime: up, incidents: st["b/s1"].incidents}
	st["b/s5"] = sourceState{components: fetched[source.Components]{data: healthy("cp", "dp"), at: t0}, uptime: up, incidents: st["b/s1"].incidents}
	return st
}

func buildLocated(st map[string]sourceState) ProductDetail {
	p := params(st, t0)
	p.products = append(p.products, locatedProduct())
	return build(p).Products["three"]
}

// TestLocationsGroupRegions: the regions of one location are listed
// together, locations in the order the configuration first names them and
// regions by name within one, so each control plane comes first whatever
// source it is read from. Summary and detail agree, and the summary carries
// the uptime figures.
func TestLocationsGroupRegions(t *testing.T) {
	t.Parallel()
	three := buildLocated(locatedState())
	want := []Location{
		{ID: "us", Name: "US", Status: domain.StatusOperational},
		{ID: "eu", Name: "EU", Status: domain.StatusOperational},
	}
	if !slices.Equal(three.Locations, want) {
		t.Fatalf("locations = %+v, want %+v", three.Locations, want)
	}
	got := make([]string, 0, len(three.Regions))
	for i, r := range three.Regions {
		got = append(got, r.Location+"/"+r.ID)
		d := three.RegionDetails[i]
		if d.ID != r.ID || d.Location != r.Location || !slices.Equal(d.Uptime, r.Uptime) || len(r.Uptime) != 1 {
			t.Errorf("region %d: summary %+v and detail %s/%s %v disagree", i, r, d.Location, d.ID, d.Uptime)
		}
	}
	if order := []string{"us/us-cp", "us/us-dp", "eu/eu-cp", "eu/eu-dp", "eu/eu-dp-us"}; !slices.Equal(got, order) {
		t.Fatalf("regions = %v, want %v", got, order)
	}
	if one := build(params(freshState(), t0)).Products["one"]; one.Locations == nil || len(one.Locations) != 0 || one.Regions[0].Location != "" {
		t.Fatalf("a product without locations: locations %#v, first region location %q", one.Locations, one.Regions[0].Location)
	}
}

// TestLocationStatusFailsClosed: a location is unknown when one of its
// regions is and no problem is known, and a known problem leads.
func TestLocationStatusFailsClosed(t *testing.T) {
	t.Parallel()
	st := locatedState()
	s5 := st["b/s5"]
	s5.components.at = t0.Add(-10 * time.Minute)
	st["b/s5"] = s5
	three := buildLocated(st)
	if got := three.Locations[1].Status; got != domain.StatusUnknown {
		t.Fatalf("EU with its own cloud stale: %v, want unknown", got)
	}
	if got := three.Locations[0].Status; got != domain.StatusOperational {
		t.Fatalf("US: %v, want operational", got)
	}
	s4 := st["b/s4"]
	s4.components.data = healthy("dp", "cp")
	s4.components.data["eu-dp"] = []domain.Group{group(domain.StatusDegraded)}
	st["b/s4"] = s4
	if got := buildLocated(st).Locations[1].Status; got != domain.StatusDegraded {
		t.Fatalf("EU with a degraded plane and two unknown: %v, want degraded", got)
	}
}

// TestUnmatchedRegionFollowsTheLocations: a region the upstream adds and the
// configuration does not name has no location and is listed last.
func TestUnmatchedRegionFollowsTheLocations(t *testing.T) {
	t.Parallel()
	st := locatedState()
	s4 := st["b/s4"]
	s4.components.data = healthy("dp", "cp", "eu-dp", "ap")
	st["b/s4"] = s4
	three := buildLocated(st)
	last := three.Regions[len(three.Regions)-1]
	if len(three.Regions) != 6 || last.ID != "ap" || last.Location != "" {
		t.Fatalf("regions = %+v", three.Regions)
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
	cfg, err := config.Load("../../../../config/statusd.yaml")
	if err != nil {
		t.Fatal(err)
	}
	limits := stalenessOf(cfg.Polling)
	read := func(path string) string {
		raw, err := os.ReadFile(path)
		if err != nil {
			t.Fatal(err)
		}
		return string(raw)
	}
	rules := read("../../../../deploy/observability/prometheus-rules.yaml")
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
	m := regexp.MustCompile(`MAX_AGE_SECONDS:-(\d+)`).FindStringSubmatch(read("../../../../scripts/ops/synthetic-check.sh"))
	if m == nil {
		t.Fatal("synthetic-check.sh: no default MAX_AGE_SECONDS")
	}
	if got, _ := strconv.Atoi(m[1]); time.Duration(got)*time.Second != cfg.Polling.StaleAfter {
		t.Errorf("synthetic-check.sh default MAX_AGE_SECONDS %s, want stale_after %s", m[1], cfg.Polling.StaleAfter)
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
