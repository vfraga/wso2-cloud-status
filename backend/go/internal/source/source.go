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

// Package source defines the contract every status data source implements.
//
// The interim implementation reads the existing status API (legacyapi); the
// CSM integration will be a second implementation of the same interface.
package source

import (
	"context"
	"time"

	"github.com/wso2/wso2-cloud-status/backend/go/internal/domain"
)

// Components maps an upstream region key to that region's component groups.
type Components map[string][]domain.Group

// Uptime maps an upstream region key to that region's uptime windows.
type Uptime map[string][]domain.Uptime

// Incidents is the incident history a source holds.
type Incidents struct {
	// Items have no ProductID; the aggregator assigns it.
	Items []domain.Incident
	// CoverageStart is the earliest instant the history is complete from.
	CoverageStart time.Time
}

// Source is one upstream that reports status for a set of regions. Each
// method is polled on its own schedule, so one failing does not block the
// others.
type Source interface {
	Components(ctx context.Context) (Components, error)
	Uptime(ctx context.Context) (Uptime, error)
	Incidents(ctx context.Context) (Incidents, error)
}
