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
	"cmp"
	"slices"
	"strings"
	"time"
)

// Component is one monitored capability, such as "Component Build".
type Component struct {
	Name        string   `json:"name"`
	Description string   `json:"description,omitempty"`
	Status      Status   `json:"status"`
	Message     string   `json:"message,omitempty"`
	Uptime      []Uptime `json:"uptime,omitempty"`
}

// Group is a named set of components within a region, such as "Development".
type Group struct {
	Name       string      `json:"name"`
	Status     Status      `json:"status"`
	Components []Component `json:"components"`
}

// Uptime is an availability percentage over a trailing window.
type Uptime struct {
	Window  string  `json:"window"`
	Percent float64 `json:"percent"`
}

// Region is one deployment of a product, such as "US control plane".
//
// It carries no fetch timestamp on purpose: freshness is per product and per
// kind of data (checked_at, at minute granularity), so a body changes at most
// once a minute while its statuses do not.
type Region struct {
	ID     string   `json:"id"`
	Name   string   `json:"name"`
	Status Status   `json:"status"`
	Uptime []Uptime `json:"uptime"`
	Groups []Group  `json:"groups"`
}

// Incident is an outage, degradation or maintenance entry declared by SRE.
type Incident struct {
	ID         string     `json:"id"`
	ProductID  string     `json:"product_id"`
	Title      string     `json:"title"`
	Impact     Status     `json:"impact"`
	State      string     `json:"state"`
	StartedAt  time.Time  `json:"started_at"`
	ResolvedAt *time.Time `json:"resolved_at"`
}

// SortIncidents orders incidents newest first, then by ID. The order is
// total, so the same incidents always encode to the same bytes: a tie on the
// start time must not reorder the body (and so change its ETag) between
// polls.
func SortIncidents(incidents []Incident) {
	slices.SortFunc(incidents, func(a, b Incident) int {
		if c := b.StartedAt.Compare(a.StartedAt); c != 0 {
			return c
		}
		return strings.Compare(a.ID, b.ID)
	})
}

// Active reports whether the incident is still open.
func (i Incident) Active() bool {
	return i.ResolvedAt == nil
}

// Later returns the copy of one incident to keep when two records share its
// ID: an open copy over a resolved one, else the one that ends later; then
// the more severe EffectiveImpact, the later start, and the title, state and
// impact as text. The open copy wins so a stale resolved copy never hides an
// outage. The order is total, so the result does not depend on which copy
// comes first: a response never changes between polls because two sources
// or two months were read in another order.
func Later(a, b Incident) Incident {
	if keepFirst(a, b) {
		return a
	}
	return b
}

// keepFirst reports whether a ranks at least as high as b for Later.
func keepFirst(a, b Incident) bool {
	if c := compareEnds(a.ResolvedAt, b.ResolvedAt); c != 0 {
		return c > 0
	}
	if c := cmp.Compare(a.EffectiveImpact(), b.EffectiveImpact()); c != 0 {
		return c > 0
	}
	if c := a.StartedAt.Compare(b.StartedAt); c != 0 {
		return c > 0
	}
	return cmp.Or(
		strings.Compare(a.Title, b.Title),
		strings.Compare(a.State, b.State),
		cmp.Compare(a.Impact, b.Impact),
	) >= 0
}

// compareEnds orders ends with open (nil) above every time.
func compareEnds(a, b *time.Time) int {
	switch {
	case a == nil && b == nil:
		return 0
	case a == nil:
		return 1
	case b == nil:
		return -1
	}
	return a.Compare(*b)
}

// EffectiveImpact is the status the incident counts as in roll-ups and the
// daily history: its impact, or degraded when the impact is unknown (an
// incident type we do not recognise). A declared incident never counts as
// less than degraded; its own impact stays unknown.
func (i Incident) EffectiveImpact() Status {
	if i.Impact.Known() {
		return i.Impact
	}
	return StatusDegraded
}

// Day is one cell of a product's daily history strip.
type Day struct {
	Date    string         `json:"date"`
	Status  Status         `json:"status"`
	Minutes map[Status]int `json:"minutes,omitempty"`
	// IncidentIDs are the incidents that touch the day, in the order
	// DailyHistory is given them; at most MaxDayIncidents (it says which).
	IncidentIDs []string `json:"incident_ids,omitempty"`
}
