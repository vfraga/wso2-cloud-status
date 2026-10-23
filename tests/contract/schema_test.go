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

package contract

import (
	"strings"
	"testing"
)

// These run without a backend: they prove the validator rejects what the
// contract forbids, so a passing contract run means something.
func TestSchemaRejectsContractViolations(t *testing.T) {
	t.Parallel()
	s, err := LoadSchemas("../../api/openapi.yaml")
	if err != nil {
		t.Fatal(err)
	}
	checked := `"checked_at":{"components":"2026-10-21T14:05:00Z","incidents":null,"uptime":"2026-10-21T14:00:00Z"},"stale":{"components":false,"incidents":true,"uptime":false}`
	row := `{"id":"p","name":"P","page_url":"https://p.test","status":"operational","affected_regions":0,"data_complete":true,"outdated":true,` + checked + `,"regions":[],"history":[]}`
	generated := `"generated_at":"2026-10-21T14:06:00Z"`
	valid := `{"status":"operational","data_complete":true,` + generated + `,"products":[` + row + `],"active_incidents":[]}`
	detail := row[:len(row)-1] + `,` + generated + `,"region_details":[],"incidents":[]}`
	list := `{` + generated + `,"incidents":[]}`
	for name, c := range map[string]struct{ schema, body string }{
		"summary": {"Summary", valid}, "product": {"ProductDetail", detail}, "incident list": {"IncidentList", list},
	} {
		if err := s.Validate(c.schema, []byte(c.body)); err != nil {
			t.Fatalf("valid %s rejected: %v", name, err)
		}
	}
	withRow := func(r string) string {
		return `{"status":"operational","data_complete":true,` + generated + `,"products":[` + r + `],"active_incidents":[]}`
	}
	invalid := map[string]struct{ schema, body string }{
		"unknown status":                {"Summary", strings.Replace(valid, `"status":"operational"`, `"status":"partial_outage"`, 1)},
		"extra top-level field":         {"Summary", strings.Replace(valid, `"products"`, `"surprise":1,"products"`, 1)},
		"extra product field":           {"Summary", withRow(row[:len(row)-1] + `,"uptime":1}`)},
		"missing required field":        {"Summary", strings.Replace(valid, `,"active_incidents":[]`, "", 1)},
		"missing summary data_complete": {"Summary", strings.Replace(valid, `"data_complete":true,`, "", 1)},
		"summary data_complete string":  {"Summary", strings.Replace(valid, `"data_complete":true,`, `"data_complete":"yes",`, 1)},
		"missing outdated":              {"Summary", withRow(strings.Replace(row, `"outdated":true,`, "", 1))},
		"missing summary generated_at":  {"Summary", strings.Replace(valid, generated+",", "", 1)},
		"generated_at with seconds":     {"Summary", strings.Replace(valid, "14:06:00Z", "14:06:07Z", 1)},
		"generated_at not in UTC":       {"Summary", strings.Replace(valid, "14:06:00Z", "16:06:00+02:00", 1)},
		"generated_at not a date":       {"Summary", strings.Replace(valid, "2026-10-21T14:06:00Z", "2026-10-21T14:66:00Z", 1)},
		"missing product generated_at":  {"ProductDetail", strings.Replace(detail, generated+",", "", 1)},
		"missing list generated_at":     {"IncidentList", `{"incidents":[]}`},
		"missing checked_at":            {"Summary", withRow(strings.Replace(row, checked+",", `"stale":{"components":false,"incidents":true,"uptime":false},`, 1))},
		"checked_at kind missing":       {"Summary", withRow(strings.Replace(row, `"incidents":null,`, "", 1))},
		"checked_at with seconds":       {"Summary", withRow(strings.Replace(row, "14:05:00Z", "14:05:30Z", 1))},
		"checked_at extra kind":         {"Summary", withRow(strings.Replace(row, `"incidents":null,`, `"incidents":null,"status":null,`, 1))},
		"missing stale":                 {"Summary", withRow(strings.Replace(row, `,"stale":{"components":false,"incidents":true,"uptime":false}`, "", 1))},
		"stale kind missing":            {"Summary", withRow(strings.Replace(row, `"uptime":false}`, `}`, 1))},
		"stale kind not a boolean":      {"Summary", withRow(strings.Replace(row, `"incidents":true`, `"incidents":"yes"`, 1))},
		"bad region id":                 {"RegionSummary", `{"id":"AP 1","name":"AP 1","status":"operational","page_url":"https://p.test"}`},
		"bad page_url":                  {"Summary", withRow(strings.Replace(row, "https://p.test", "not a url", 1))},
		"extra detail field":            {"ProductDetail", detail[:len(detail)-1] + `,"surprise":true}`},
		"bad date":                      {"IncidentList", `{` + generated + `,"incidents":[{"id":"i","product_id":"p","title":"t","impact":"outage","state":"resolved","started_at":"yesterday","resolved_at":null}]}`},
		"percent over 100":              {"Uptime", `{"window":"7d","percent":101}`},
	}
	for name, c := range invalid {
		if err := s.Validate(c.schema, []byte(c.body)); err == nil {
			t.Errorf("%s: accepted, want rejected", name)
		}
	}
}
