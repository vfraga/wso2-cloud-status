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
	"regexp"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

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

// jsonNumber is JSON's number grammar (RFC 8259 section 6). ParseFloat also
// reads forms no JSON number takes ("NaN", "Inf", "0x1p-2", "1_0", "+5"), so
// a figure must match this first.
var jsonNumber = regexp.MustCompile(`^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?$`)

// toUptime reads uptime figures one by one. Uptime is secondary detail: a
// figure that is not a percentage (null, empty, "NaN") is dropped, and the
// others, and every status, stay.
func toUptime(entries []wireAvailability) []domain.Uptime {
	out := make([]domain.Uptime, 0, len(entries))
	for _, e := range entries {
		text := strings.TrimSpace(string(e.Availability))
		if !jsonNumber.MatchString(text) {
			continue
		}
		pct, err := strconv.ParseFloat(text, 64)
		if err != nil || pct < 0 || pct > 100 {
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

// Limits on one answer, each at least ten times what the largest captured
// real answer holds. An answer above one is rejected like a malformed one:
// only that source's data of that kind reads as not received, and a faulty
// upstream cannot inflate every response or slow every product's build (each
// build compares the records of one event with each other, and every region
// key the upstream reports is shown).
const (
	MaxIncidents  = 500  // incident records, across months
	MaxRegions    = 50   // region keys
	MaxGroups     = 200  // component groups, across regions
	MaxComponents = 500  // components, across groups
	MaxFigures    = 1000 // uptime figures, across regions or components
	MaxText       = 1000 // characters in one key, name, description, message, title or window
)

// The times an answer may hold. JSON cannot encode a year outside 0-9999,
// so one such time would stop every product's snapshot; nothing real falls
// outside these.
var (
	earliest = time.Date(2000, 1, 1, 0, 0, 0, 0, time.UTC)
	latest   = time.Date(2100, 1, 1, 0, 0, 0, 0, time.UTC)
)

func checkTime(what string, t time.Time) error {
	if t.Before(earliest) || !t.Before(latest) {
		return fmt.Errorf("legacyapi: %s %s is outside %d-%d", what, t.UTC().Format(time.DateTime), earliest.Year(), latest.Year()-1)
	}
	return nil
}

// measure counts what one answer holds against the limits above and keeps
// the first limit it passes in err.
type measure struct {
	counts  map[string]int
	limit   map[string]int
	longest int
	err     error
}

func (m *measure) count(what string, n, most int) {
	if m.counts == nil {
		m.counts, m.limit = map[string]int{}, map[string]int{}
	}
	m.counts[what] += n
	m.limit[what] = most
	if m.err == nil && m.counts[what] > most {
		m.err = fmt.Errorf("legacyapi: %d %s, more than the %d one answer may hold", m.counts[what], what, most)
	}
}

func (m *measure) text(values ...string) {
	for _, v := range values {
		n := utf8.RuneCountInString(v)
		m.longest = max(m.longest, n)
		if m.err == nil && n > MaxText {
			m.err = fmt.Errorf("legacyapi: a value of %d characters, more than the %d one may hold", n, MaxText)
		}
	}
}

func (m *measure) figures(entries []wireAvailability) {
	m.count("uptime figures", len(entries), MaxFigures)
	for _, e := range entries {
		m.text(e.Duration, string(e.Availability))
	}
}

func measureComponents(raw map[string][]wireGroup) measure {
	var m measure
	for region, groups := range raw {
		m.count("region keys", 1, MaxRegions)
		m.count("component groups", len(groups), MaxGroups)
		m.text(region)
		for _, g := range groups {
			m.count("components", len(g.Subgroups), MaxComponents)
			m.text(g.DisplayName)
			for _, c := range g.Subgroups {
				m.text(c.DisplayName, c.Description, c.Message)
				m.figures(c.Availability)
			}
		}
	}
	return m
}

func measureUptime(raw map[string][]wireAvailability) measure {
	var m measure
	for region, entries := range raw {
		m.count("region keys", 1, MaxRegions)
		m.text(region)
		m.figures(entries)
	}
	return m
}

func measureIncidents(raw map[string]wireMonth) measure {
	var m measure
	for month, w := range raw {
		m.count("incidents", len(w.Incidents), MaxIncidents)
		m.text(month)
		for _, inc := range w.Incidents {
			m.text(inc.ID, inc.Type, inc.Status, inc.ShortDescription)
		}
	}
	return m
}

func toIncidents(raw map[string]wireMonth, loc *time.Location) (source.Incidents, error) {
	if err := measureIncidents(raw).err; err != nil {
		return source.Incidents{}, err
	}
	var res source.Incidents
	seen := map[string]bool{}
	for month, m := range raw {
		start, err := monthStart(month, loc)
		if err != nil {
			return source.Incidents{}, err
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

// monthStart reads a month key such as "2026-10" as the start of that month.
func monthStart(month string, loc *time.Location) (time.Time, error) {
	start, err := time.ParseInLocation("2006-1", month, loc)
	if err != nil {
		return time.Time{}, fmt.Errorf("legacyapi: incident month key %q: %w", month, err)
	}
	return start, checkTime("incident month", start)
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
	if err := checkTime("incident "+id+" begin", started); err != nil {
		return domain.Incident{}, err
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
	if err := checkTime("incident "+w.ID+" end", end); err != nil {
		return time.Time{}, err
	}
	if end.Before(started) {
		return started.UTC(), nil
	}
	return end.UTC(), nil
}
