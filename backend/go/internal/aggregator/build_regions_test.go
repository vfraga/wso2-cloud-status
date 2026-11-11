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
	"slices"
	"testing"
	"time"

	"github.com/wso2/wso2-cloud-status/backend/go/internal/config"
	"github.com/wso2/wso2-cloud-status/backend/go/internal/domain"
)

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
		{ID: "a", Name: "A", Sources: []config.SourceRef{
			{Backend: "b", Cloud: "x", Regions: []config.RegionRef{{Key: "us", ID: "us", Name: "US"}}},
		}},
		{ID: "b", Name: "B", Sources: []config.SourceRef{
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
