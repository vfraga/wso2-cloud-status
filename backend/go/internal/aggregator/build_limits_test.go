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
	"fmt"
	"os"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/wso2/wso2-cloud-status/backend/go/internal/domain"
	"github.com/wso2/wso2-cloud-status/backend/go/internal/source/legacyapi"
	"github.com/wso2/wso2-cloud-status/backend/go/internal/testutil"
)

// atTheCap gives every source as many incident records as one answer may
// hold (legacyapi.MaxIncidents), each from record(source, i).
func atTheCap(record func(key string, i int) domain.Incident) map[string]sourceState {
	st := freshState()
	for _, key := range []string{"b/s1", "b/s2", "b/s3"} {
		items := make([]domain.Incident, legacyapi.MaxIncidents)
		for i := range items {
			items[i] = record(key, i)
		}
		s := st[key]
		s.incidents.data.Items = items
		st[key] = s
	}
	return st
}

// collapseAtTheCap is every source at the cap with records of one event
// (spacing 0) or of distinct events.
func collapseAtTheCap(spacing time.Duration) map[string]sourceState {
	return atTheCap(func(key string, i int) domain.Incident {
		start := t0.Add(-48*time.Hour + time.Duration(i)*spacing)
		return domain.Incident{
			ID: fmt.Sprintf("%s-%d", key, i), Title: "Outage", Impact: domain.StatusOutage,
			StartedAt: start, ResolvedAt: resolved(start.Add(time.Hour)),
		}
	})
}

// TestIncidentCollapseAtTheCap: at the cap, records of one event are one
// incident and records of distinct events stay apart. How long that takes
// is BenchmarkBuildAtTheCap's to measure, not a test's to time.
func TestIncidentCollapseAtTheCap(t *testing.T) {
	t.Parallel()
	n := legacyapi.MaxIncidents
	for _, tt := range []struct {
		name    string
		spacing time.Duration
		want    int
	}{{"one event", 0, 1}, {"distinct events", 2 * collapseWindow, n}} {
		b := build(params(collapseAtTheCap(tt.spacing), t0))
		if one, two := len(b.Products["one"].Incidents), len(b.Products["two"].Incidents); one != tt.want || two != tt.want {
			t.Errorf("%s: one lists %d incidents, two lists %d; want %d each", tt.name, one, two, tt.want)
		}
	}
}

// BenchmarkBuildAtTheCap: one build with every source at the cap. Each
// record is compared only with the records that start within
// collapseWindow of it, so even one event of MaxIncidents records builds in
// milliseconds.
func BenchmarkBuildAtTheCap(b *testing.B) {
	for _, bb := range []struct {
		name    string
		spacing time.Duration
	}{{"one event", 0}, {"distinct events", 2 * collapseWindow}} {
		st := collapseAtTheCap(bb.spacing)
		b.Run(bb.name, func(b *testing.B) {
			for b.Loop() {
				build(params(st, t0))
			}
		})
	}
}

// TestResponseSizesAtTheCaps: with every source at the cap of open
// incidents, each with an id as long as one may be and spanning the whole
// history, the summary stays small (MaxSummaryIncidents per product, no
// history), a product's route grows with its own records only
// (MaxDayIncidents ids per day), and the incident list grows with the
// records. A faulty source therefore cannot make every reader's poll a
// download of megabytes.
func TestResponseSizesAtTheCaps(t *testing.T) {
	t.Parallel()
	const days = 90
	st := atTheCap(func(key string, i int) domain.Incident {
		id := fmt.Sprintf("%s-%d-", key, i)
		return domain.Incident{
			ID: id + strings.Repeat("x", legacyapi.MaxID-len(id)), Title: fmt.Sprintf("Outage %s %d", key, i),
			Impact: domain.StatusOutage, State: "investigating", StartedAt: t0.AddDate(0, 0, -days-10),
		}
	})
	p := params(st, t0)
	p.days = days
	b := build(p)
	size := func(v any) int {
		raw, err := json.Marshal(v)
		if err != nil {
			t.Fatal(err)
		}
		return len(raw)
	}
	n := legacyapi.MaxIncidents
	if got := len(b.Summary.ActiveIncidents); got != 2*MaxSummaryIncidents {
		t.Errorf("summary lists %d active incidents, want %d per product", got, MaxSummaryIncidents)
	}
	for _, sp := range b.Summary.Products {
		if want := n * len(sourcesByProduct[sp.ID]); sp.ActiveIncidentCount != want {
			t.Errorf("%s: active_incident_count %d, want %d", sp.ID, sp.ActiveIncidentCount, want)
		}
	}
	if got, most := size(b.Summary), 64<<10; got > most {
		t.Errorf("summary is %d bytes, more than %d", got, most)
	}
	for id, d := range b.Products {
		for _, day := range d.History {
			if len(day.IncidentIDs) != domain.MaxDayIncidents {
				t.Fatalf("%s %s lists %d incident ids, want %d", id, day.Date, len(day.IncidentIDs), domain.MaxDayIncidents)
			}
		}
		if got, most := size(d), 1<<20; got > most {
			t.Errorf("%s is %d bytes, more than %d", id, got, most)
		}
	}
	if got, most := size(b.Incidents), 3*n*300; got > most {
		t.Errorf("incident list is %d bytes, more than %d (300 per record)", got, most)
	}
}

// sourcesByProduct is testConfig's sources per product.
var sourcesByProduct = map[string][]string{"one": {"b/s1"}, "two": {"b/s2", "b/s3"}}

// TestSummaryListsAFewActiveIncidentsPerProduct: the summary lists a
// product's newest MaxSummaryIncidents active incidents and counts them
// all; the product's own route lists every one. Another product's fewer
// incidents are all listed beside them.
func TestSummaryListsAFewActiveIncidentsPerProduct(t *testing.T) {
	t.Parallel()
	st := freshState()
	totals := map[string]int{"one": MaxSummaryIncidents + 5, "two": 3}
	for id, total := range totals {
		key := sourcesByProduct[id][0]
		s := st[key]
		for i := range total {
			s.incidents.data.Items = append(s.incidents.data.Items, domain.Incident{
				ID: fmt.Sprintf("%s-open-%02d", id, i), Title: fmt.Sprintf("Outage %d", i), Impact: domain.StatusDegraded,
				StartedAt: t0.Add(-time.Duration(i+1) * time.Hour),
			})
		}
		st[key] = s
	}
	b := build(params(st, t0))
	if got, want := len(b.Summary.ActiveIncidents), MaxSummaryIncidents+totals["two"]; got != want {
		t.Fatalf("summary lists %d, want %d: %d of one's and all %d of two's", got, want, MaxSummaryIncidents, totals["two"])
	}
	var listed []string
	for _, inc := range b.Summary.ActiveIncidents {
		if inc.ProductID == "one" {
			listed = append(listed, inc.ID)
		}
	}
	if len(listed) != MaxSummaryIncidents || listed[0] != "one-open-00" || listed[len(listed)-1] != fmt.Sprintf("one-open-%02d", MaxSummaryIncidents-1) {
		t.Errorf("summary lists %v of one's, want its %d newest", listed, MaxSummaryIncidents)
	}
	for _, sp := range b.Summary.Products {
		if sp.ActiveIncidentCount != totals[sp.ID] {
			t.Errorf("%s: active_incident_count %d, want %d", sp.ID, sp.ActiveIncidentCount, totals[sp.ID])
		}
		if got := len(b.Products[sp.ID].Incidents); got != totals[sp.ID] {
			t.Errorf("%s: the product's route lists %d, want every one, %d", sp.ID, got, totals[sp.ID])
		}
	}
}

// TestCopiesOfTheResponseLimits: the API contract, the READMEs and the
// contract tests state MaxSummaryIncidents and domain.MaxDayIncidents in
// words; each copy must say what the code does.
func TestCopiesOfTheResponseLimits(t *testing.T) {
	t.Parallel()
	read := func(parts ...string) string {
		raw, err := os.ReadFile(testutil.RepoPath(parts...))
		if err != nil {
			t.Fatal(err)
		}
		// Prose wraps anywhere: compare with single spaces.
		return strings.Join(strings.Fields(string(raw)), " ")
	}
	summary, day := strconv.Itoa(MaxSummaryIncidents), strconv.Itoa(domain.MaxDayIncidents)
	for file, copies := range map[string][]string{
		"api/openapi.yaml": {
			"maxItems: " + day,
			"At most " + day + ": when more touch it",
			"The summary lists at most " + summary + " of them",
			"at most " + summary + " per product",
		},
		"backend/go/README.md":            {"the " + summary + " newest per product"},
		"frontend/README.md":              {"at most the " + summary + " newest per product"},
		"tests/contract/contract_test.go": {"const maxSummaryIncidents = " + summary},
	} {
		text := read(strings.Split(file, "/")...)
		for _, want := range copies {
			if !strings.Contains(text, want) {
				t.Errorf("%s does not say %q", file, want)
			}
		}
	}
}
