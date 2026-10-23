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
	"encoding/json"
	"testing"
)

func TestWorst(t *testing.T) {
	t.Parallel()
	tests := []struct {
		name string
		in   []Status
		want Status
	}{
		{"no inputs is unknown", nil, StatusUnknown},
		{"all unknown is unknown", []Status{StatusUnknown, StatusUnknown}, StatusUnknown},
		{"unknown is skipped", []Status{StatusUnknown, StatusOperational}, StatusOperational},
		{"maintenance beats operational", []Status{StatusOperational, StatusMaintenance}, StatusMaintenance},
		{"degraded beats maintenance", []Status{StatusMaintenance, StatusDegraded}, StatusDegraded},
		{"outage beats everything", []Status{StatusDegraded, StatusOutage, StatusUnknown, StatusOperational}, StatusOutage},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			if got := Worst(tt.in...); got != tt.want {
				t.Fatalf("Worst(%v) = %v, want %v", tt.in, got, tt.want)
			}
		})
	}
}

func TestStatusJSONRoundTrip(t *testing.T) {
	t.Parallel()
	for status, name := range statusNames {
		raw, err := json.Marshal(status)
		if err != nil {
			t.Fatalf("marshal %v: %v", status, err)
		}
		if string(raw) != `"`+name+`"` {
			t.Fatalf("marshal %v = %s, want %q", status, raw, name)
		}
		var back Status
		if err := json.Unmarshal(raw, &back); err != nil {
			t.Fatalf("unmarshal %s: %v", raw, err)
		}
		if back != status {
			t.Fatalf("round trip %v = %v", status, back)
		}
	}
}

func TestStatusUnmarshalRejectsUnknownName(t *testing.T) {
	t.Parallel()
	var s Status
	if err := json.Unmarshal([]byte(`"partial_outage"`), &s); err == nil {
		t.Fatal("expected an error for an unrecognised status name")
	}
}

func TestStatusStringOutOfRange(t *testing.T) {
	t.Parallel()
	if got := Status(42).String(); got != "unknown" {
		t.Fatalf("Status(42).String() = %q, want unknown", got)
	}
}

func TestRollUps(t *testing.T) {
	t.Parallel()
	g := []Component{{Status: StatusOperational}, {Status: StatusDegraded}}
	if got := GroupStatus(g); got != StatusDegraded {
		t.Fatalf("GroupStatus = %v, want degraded", got)
	}
	r := []Group{{Status: StatusOperational}, {Status: StatusUnknown}}
	if got := RegionStatus(r); got != StatusOperational {
		t.Fatalf("RegionStatus = %v, want operational", got)
	}
	if got := GroupStatus(nil); got != StatusUnknown {
		t.Fatalf("GroupStatus(nil) = %v, want unknown", got)
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

func TestStatusesListsEveryStatusOnce(t *testing.T) {
	t.Parallel()
	all := Statuses()
	seen := map[Status]bool{}
	for i, s := range all {
		if _, named := statusNames[s]; !named || seen[s] || (i > 0 && s <= all[i-1]) {
			t.Fatalf("Statuses() = %v: want each named status once, in order", all)
		}
		seen[s] = true
	}
	if len(all) != len(statusNames) {
		t.Fatalf("Statuses() has %d statuses, want %d", len(all), len(statusNames))
	}
}
