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
	"testing"
	"time"

	"github.com/wso2/wso2-cloud-status/backend/go/internal/domain"
	"github.com/wso2/wso2-cloud-status/backend/go/internal/source"
)

func TestAllHealthy(t *testing.T) {
	t.Parallel()
	b := build(params(freshState(), t0))
	if b.Summary.Status != domain.StatusOperational || !b.Summary.DataComplete || !b.Ready {
		t.Fatalf("summary = %v complete=%v ready=%v", b.Summary.Status, b.Summary.DataComplete, b.Ready)
	}
	for _, p := range b.Summary.Products {
		if p.Status != domain.StatusOperational || p.AffectedRegions != 0 || !p.DataComplete || p.Outdated || len(b.Products[p.ID].History) != 7 {
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

// TestExtentSaysHowMuchCarriesTheStatus: a product or the whole page is
// "all" only when every one of its regions has its status, whatever raised
// the product statuses.
func TestExtentSaysHowMuchCarriesTheStatus(t *testing.T) {
	t.Parallel()
	down := source.Components{"cp": []domain.Group{group(domain.StatusOutage)}}
	st := freshState()
	s3 := st["b/s3"]
	s3.components.data = down
	st["b/s3"] = s3
	b := build(params(st, t0))
	if two := b.Products["two"]; two.Status != domain.StatusOutage || two.Extent != domain.ExtentSome {
		t.Fatalf("two = %v %s, want outage in some of its regions", two.Status, two.Extent)
	}
	if b.Summary.Status != domain.StatusOutage || b.Summary.Extent != domain.ExtentSome {
		t.Fatalf("summary = %v %s, want outage in some", b.Summary.Status, b.Summary.Extent)
	}
	s2 := st["b/s2"]
	s2.components.data = down
	st["b/s2"] = s2
	if two := build(params(st, t0)).Products["two"]; two.Extent != domain.ExtentAll {
		t.Fatalf("two = %s, want all once both its regions are out", two.Extent)
	}
	s1 := st["b/s1"]
	s1.components.data = source.Components{
		"us": []domain.Group{group(domain.StatusOutage)}, "eu": []domain.Group{group(domain.StatusOutage)},
	}
	st["b/s1"] = s1
	if all := build(params(st, t0)).Summary; all.Extent != domain.ExtentAll {
		t.Fatalf("summary = %s, want all when every region of every product is out", all.Extent)
	}

	// Every product in outage, two of them only by an open incident: the
	// summary's extent follows the regions, not the product statuses.
	st = locatedState()
	s1 = st["b/s1"]
	s1.components.data = source.Components{"us": []domain.Group{group(domain.StatusOutage)}, "eu": []domain.Group{group(domain.StatusOperational)}}
	st["b/s1"] = s1
	for _, key := range []string{"b/s2", "b/s4"} {
		s := st[key]
		s.incidents.data.Items = []domain.Incident{{ID: "open-" + key, Title: "Outage", Impact: domain.StatusOutage, StartedAt: t0.Add(-time.Hour)}}
		st[key] = s
	}
	p := params(st, t0)
	p.products = append(p.products, locatedProduct())
	b = build(p)
	for _, id := range []string{"one", "two", "three"} {
		if got := b.Products[id]; got.Status != domain.StatusOutage || got.Extent != domain.ExtentSome {
			t.Fatalf("%s = %v %s, want outage in some of its regions", id, got.Status, got.Extent)
		}
	}
	if b.Summary.Status != domain.StatusOutage || b.Summary.Extent != domain.ExtentSome {
		t.Fatalf("summary = %v %s, want outage in some: most regions are operational", b.Summary.Status, b.Summary.Extent)
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
