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
	"time"

	"github.com/wso2/wso2-cloud-status/backend/go/internal/domain"
)

// The views are the public API bodies. Their JSON shape is the contract in
// api/openapi.yaml; change both together.

// Summary is the body of GET /api/v1/summary.
type Summary struct {
	Status domain.Status `json:"status"`
	// DataComplete is true when every product has complete data
	// (ProductSummary.DataComplete) and a known status.
	DataComplete bool `json:"data_complete"`
	// GeneratedAt is when this snapshot was built, in UTC and floored to
	// the minute (see minuteOf).
	GeneratedAt     time.Time         `json:"generated_at"`
	Products        []ProductSummary  `json:"products"`
	ActiveIncidents []domain.Incident `json:"active_incidents"`
}

// ProductSummary is one product row on the summary page.
type ProductSummary struct {
	ID          string        `json:"id"`
	Name        string        `json:"name"`
	Description string        `json:"description,omitempty"`
	PageURL     string        `json:"page_url"`
	Status      domain.Status `json:"status"`
	// AffectedRegions counts regions that are not operational.
	AffectedRegions int `json:"affected_regions"`
	// DataComplete is false when the status of any region, or of any
	// component in it, is unknown.
	DataComplete bool `json:"data_complete"`
	// Outdated is Stale.Incidents or Stale.Uptime. The last known data is
	// still shown.
	Outdated  bool      `json:"outdated"`
	CheckedAt CheckedAt `json:"checked_at"`
	Stale     Stale     `json:"stale"`
	// Locations group the regions that are parts of one place; empty when
	// the product's regions are places themselves.
	Locations []Location      `json:"locations"`
	Regions   []RegionSummary `json:"regions"`
	History   []domain.Day    `json:"history"`
}

// Location is a place a product runs in, such as US, whose regions are its
// parts (a control plane, a data plane). Its status is failClosed over
// theirs.
type Location struct {
	ID     string        `json:"id"`
	Name   string        `json:"name"`
	Status domain.Status `json:"status"`
}

// CheckedAt holds, per kind of data, the oldest last successful fetch among
// a product's sources, in UTC and floored to the minute. A kind is nil while
// any of the sources has never answered for it. "Checked" is when the data
// was last read, not when it last changed. It moves forward once a minute,
// with GeneratedAt, or when the product's Stale flags change (see hold).
type CheckedAt struct {
	Components *time.Time `json:"components"`
	Incidents  *time.Time `json:"incidents"`
	Uptime     *time.Time `json:"uptime"`
}

// Stale tells, per kind of data, whether any of a product's sources has
// never answered for it or answered longer ago than that kind's staleness.
type Stale struct {
	Components bool `json:"components"`
	Incidents  bool `json:"incidents"`
	Uptime     bool `json:"uptime"`
}

// RegionSummary is one region inside a product row.
type RegionSummary struct {
	ID string `json:"id"`
	// Location is the ID of the Location the region is part of, if any.
	Location string          `json:"location,omitempty"`
	Name     string          `json:"name"`
	Status   domain.Status   `json:"status"`
	Uptime   []domain.Uptime `json:"uptime"`
	PageURL  string          `json:"page_url"`
}

// ProductDetail is the body of GET /api/v1/products/{id}.
type ProductDetail struct {
	ProductSummary
	// GeneratedAt is Summary.GeneratedAt of the same snapshot.
	GeneratedAt   time.Time         `json:"generated_at"`
	RegionDetails []RegionDetail    `json:"region_details"`
	Incidents     []domain.Incident `json:"incidents"`
}

// RegionDetail is a region with its component groups and uptime.
type RegionDetail struct {
	domain.Region
	// Location is RegionSummary.Location.
	Location string `json:"location,omitempty"`
	PageURL  string `json:"page_url"`
}

// Incidents is the body of GET /api/v1/incidents.
type Incidents struct {
	// GeneratedAt is Summary.GeneratedAt of the same snapshot.
	GeneratedAt time.Time         `json:"generated_at"`
	Incidents   []domain.Incident `json:"incidents"`
}
