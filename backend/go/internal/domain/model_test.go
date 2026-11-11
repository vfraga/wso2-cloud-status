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
	"math/rand/v2"
	"reflect"
	"slices"
	"testing"
	"time"
)

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

// TestLaterIsOrderFree: of two copies of one incident, Later keeps the same
// one whichever comes first, the open copy over a resolved one, the later end
// among resolved copies and the more severe impact among open ones.
func TestLaterIsOrderFree(t *testing.T) {
	t.Parallel()
	copies := make([]Incident, 0, 72)
	for _, end := range []*time.Time{nil, ptr(at("2026-10-20 10:00:00")), ptr(at("2026-10-20 11:00:00"))} {
		for _, impact := range []Status{StatusUnknown, StatusDegraded, StatusOutage} {
			for _, start := range []time.Time{at("2026-10-20 08:00:00"), at("2026-10-20 09:00:00")} {
				for _, title := range []string{"A", "B"} {
					for _, state := range []string{"investigating", "resolved"} {
						copies = append(copies, Incident{ID: "x", Title: title, Impact: impact, State: state, StartedAt: start, ResolvedAt: end})
					}
				}
			}
		}
	}
	for _, a := range copies {
		for _, b := range copies {
			ab, ba := Later(a, b), Later(b, a)
			if !reflect.DeepEqual(ab, ba) {
				t.Fatalf("Later(%+v, %+v) = %+v, but the other order keeps %+v", a, b, ab, ba)
			}
			switch {
			case (a.ResolvedAt == nil) != (b.ResolvedAt == nil):
				if ab.ResolvedAt != nil {
					t.Fatalf("kept the resolved copy %+v over an open one", ab)
				}
			case a.ResolvedAt != nil && !a.ResolvedAt.Equal(*b.ResolvedAt):
				if !ab.ResolvedAt.Equal(maxTime(*a.ResolvedAt, *b.ResolvedAt)) {
					t.Fatalf("kept %+v, not the copy that ends later", ab)
				}
			case a.ResolvedAt == nil && a.EffectiveImpact() != b.EffectiveImpact():
				if ab.EffectiveImpact() != Worst(a.EffectiveImpact(), b.EffectiveImpact()) {
					t.Fatalf("kept %+v, not the more severe open copy", ab)
				}
			}
		}
	}
}

func TestEffectiveImpact(t *testing.T) {
	t.Parallel()
	for impact, want := range map[Status]Status{
		StatusUnknown: StatusDegraded, StatusOperational: StatusOperational, StatusMaintenance: StatusMaintenance,
		StatusDegraded: StatusDegraded, StatusOutage: StatusOutage,
	} {
		if got := (Incident{Impact: impact}).EffectiveImpact(); got != want {
			t.Errorf("EffectiveImpact(%v) = %v, want %v", impact, got, want)
		}
	}
}
