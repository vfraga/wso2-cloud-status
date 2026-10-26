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

package legacyapi

import (
	"fmt"
	"math"
	"strconv"
	"strings"
	"time"

	"github.com/wso2/wso2-cloud-status/backend/go/internal/domain"
	"github.com/wso2/wso2-cloud-status/backend/go/internal/source"
)

// Wire types mirror the upstream JSON exactly; nothing outside this file
// sees them.

type wireAvailability struct {
	Availability wirePercent `json:"availability"`
	Duration     string      `json:"duration"`
}

// wirePercent accepts both encodings seen in production: the cloudservices
// backend sends "100.000" (a string), the Asgardeo backend sends 99.998 (a
// number). Both are kept as text and parsed in one place.
type wirePercent string

func (p *wirePercent) UnmarshalJSON(data []byte) error {
	text := strings.TrimSpace(string(data))
	if unquoted, err := strconv.Unquote(text); err == nil {
		text = unquoted
	}
	*p = wirePercent(text)
	return nil
}

type wireComponent struct {
	DisplayName string `json:"display_name"`
	Description string `json:"description"`
	// Status is a pointer so an absent or null status reads as unknown, not
	// as 0 (operational).
	Status       *int               `json:"status"`
	Message      string             `json:"message"`
	Availability []wireAvailability `json:"availability"`
}

type wireGroup struct {
	DisplayName string          `json:"display_name"`
	Subgroups   []wireComponent `json:"subgroups"`
}

type wireIncident struct {
	ID               string  `json:"id"`
	Begin            string  `json:"begin"`
	End              *string `json:"end"`
	Type             string  `json:"type"`
	Status           string  `json:"status"`
	ShortDescription string  `json:"short_description"`
}

type wireMonth struct {
	Incidents []wireIncident `json:"incidents"`
}

// statusCodes is the upstream encoding, read from the existing frontend's
// statusCode table: Operational 0, Maintenance 1, Degraded 2, Outage 3.
var statusCodes = map[int]domain.Status{
	0: domain.StatusOperational,
	1: domain.StatusMaintenance,
	2: domain.StatusDegraded,
	3: domain.StatusOutage,
}

var impacts = map[string]domain.Status{
	"operational": domain.StatusOperational,
	"maintenance": domain.StatusMaintenance,
	"degraded":    domain.StatusDegraded,
	"outage":      domain.StatusOutage,
}

var windows = map[string]string{
	"last 7 days":    "7d",
	"last 30 days":   "30d",
	"last 90 days":   "90d",
	"last 12 months": "12mo",
}

func statusFromCode(code *int) domain.Status {
	if code == nil {
		return domain.StatusUnknown
	}
	if s, ok := statusCodes[*code]; ok {
		return s
	}
	return domain.StatusUnknown
}

func window(duration string) string {
	key := strings.ToLower(strings.TrimSpace(duration))
	if w, ok := windows[key]; ok {
		return w
	}
	return key
}

// toUptime reads uptime figures one by one. Uptime is secondary detail: a
// figure that is not a percentage (null, empty, "NaN") is dropped, and the
// others, and every status, stay.
func toUptime(entries []wireAvailability) []domain.Uptime {
	out := make([]domain.Uptime, 0, len(entries))
	for _, e := range entries {
		pct, err := strconv.ParseFloat(strings.TrimSpace(string(e.Availability)), 64)
		// ParseFloat accepts "NaN" and "Inf", which JSON cannot encode.
		if err != nil || math.IsNaN(pct) || pct < 0 || pct > 100 {
			continue
		}
		out = append(out, domain.Uptime{Window: window(e.Duration), Percent: pct})
	}
	return out
}

func toComponents(raw map[string][]wireGroup) source.Components {
	out := make(source.Components, len(raw))
	for region, groups := range raw {
		converted := make([]domain.Group, 0, len(groups))
		for _, g := range groups {
			converted = append(converted, toGroup(g))
		}
		out[region] = converted
	}
	return out
}

func toGroup(g wireGroup) domain.Group {
	components := make([]domain.Component, 0, len(g.Subgroups))
	for _, c := range g.Subgroups {
		uptime := toUptime(c.Availability)
		if len(uptime) == 0 {
			uptime = nil
		}
		components = append(components, domain.Component{
			Name:        strings.TrimSpace(c.DisplayName),
			Description: strings.TrimSpace(c.Description),
			Status:      statusFromCode(c.Status),
			Message:     strings.TrimSpace(c.Message),
			Uptime:      uptime,
		})
	}
	return domain.Group{
		Name:       strings.TrimSpace(g.DisplayName),
		Status:     domain.GroupStatus(components),
		Components: components,
	}
}

func toRegionUptime(raw map[string][]wireAvailability) source.Uptime {
	out := make(source.Uptime, len(raw))
	for region, entries := range raw {
		out[region] = toUptime(entries)
	}
	return out
}

// MaxIncidents caps the incident records one answer may hold, at least ten
// times as many as the largest captured real answer. Each build compares the
// records of one event with each other to list them once, so an answer above
// the cap is rejected like a malformed one: only that source's incidents
// read as not received, and a faulty upstream cannot slow every product's
// build.
const MaxIncidents = 500

// incidentCount is the number of incident records in an answer.
func incidentCount(raw map[string]wireMonth) int {
	total := 0
	for _, m := range raw {
		total += len(m.Incidents)
	}
	return total
}

func toIncidents(raw map[string]wireMonth, loc *time.Location) (source.Incidents, error) {
	if n := incidentCount(raw); n > MaxIncidents {
		return source.Incidents{}, fmt.Errorf("legacyapi: %d incidents, more than the %d one answer may hold", n, MaxIncidents)
	}
	var res source.Incidents
	seen := map[string]bool{}
	for month, m := range raw {
		start, err := time.ParseInLocation("2006-1", month, loc)
		if err != nil {
			return source.Incidents{}, fmt.Errorf("legacyapi: incident month key %q: %w", month, err)
		}
		if res.CoverageStart.IsZero() || start.Before(res.CoverageStart) {
			res.CoverageStart = start.UTC()
		}
		for _, w := range m.Incidents {
			inc, err := toIncident(w, loc)
			if err != nil {
				return source.Incidents{}, err
			}
			// Incidents are told apart by id downstream, so a repeated id
			// would hide one of them.
			if seen[inc.ID] {
				return source.Incidents{}, fmt.Errorf("legacyapi: incident id %q appears twice", inc.ID)
			}
			seen[inc.ID] = true
			res.Items = append(res.Items, inc)
		}
	}
	domain.SortIncidents(res.Items)
	return res, nil
}

func toIncident(w wireIncident, loc *time.Location) (domain.Incident, error) {
	id := strings.TrimSpace(w.ID)
	if id == "" {
		return domain.Incident{}, fmt.Errorf("legacyapi: incident with no id, begin %q", w.Begin)
	}
	started, err := time.ParseInLocation(time.DateTime, strings.TrimSpace(w.Begin), loc)
	if err != nil {
		return domain.Incident{}, fmt.Errorf("legacyapi: incident %s begin %q: %w", id, w.Begin, err)
	}
	inc := domain.Incident{
		ID:        id,
		Title:     strings.TrimSpace(w.ShortDescription),
		Impact:    impacts[strings.ToLower(strings.TrimSpace(w.Type))],
		State:     strings.ToLower(strings.TrimSpace(w.Status)),
		StartedAt: started.UTC(),
	}
	// The upstream resolves an incident by setting its end time, whatever
	// the status word says; a "Resolved" record with no end is zero-length.
	ended := w.End != nil && strings.TrimSpace(*w.End) != ""
	if !ended && inc.State != "resolved" {
		return inc, nil
	}
	resolved, err := resolvedAt(w, started, loc)
	if err != nil {
		return domain.Incident{}, err
	}
	inc.ResolvedAt = &resolved
	return inc, nil
}

// resolvedAt reads the end of a resolved incident. A resolved incident with
// no end time, or one that ends before it begins, is treated as zero-length
// at its start rather than as still open, so it still marks its day.
func resolvedAt(w wireIncident, started time.Time, loc *time.Location) (time.Time, error) {
	if w.End == nil || strings.TrimSpace(*w.End) == "" {
		return started.UTC(), nil
	}
	end, err := time.ParseInLocation(time.DateTime, strings.TrimSpace(*w.End), loc)
	if err != nil {
		return time.Time{}, fmt.Errorf("legacyapi: incident %s end %q: %w", w.ID, *w.End, err)
	}
	if end.Before(started) {
		return started.UTC(), nil
	}
	return end.UTC(), nil
}
