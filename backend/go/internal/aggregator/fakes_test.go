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
	"context"
	"errors"
	"sync"
	"time"

	"github.com/wso2/wso2-cloud-status/backend/go/internal/config"
	"github.com/wso2/wso2-cloud-status/backend/go/internal/domain"
	"github.com/wso2/wso2-cloud-status/backend/go/internal/source"
)

var errUpstream = errors.New("upstream down")

// fakeSource is an in-memory source.Source whose answers tests can change.
type fakeSource struct {
	mu         sync.Mutex
	components source.Components
	uptime     source.Uptime
	incidents  source.Incidents
	fail       bool
	calls      int
}

func (f *fakeSource) set(fn func(*fakeSource)) {
	f.mu.Lock()
	defer f.mu.Unlock()
	fn(f)
}

func (f *fakeSource) answer() error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.calls++
	if f.fail {
		return errUpstream
	}
	return nil
}

func (f *fakeSource) Components(context.Context) (source.Components, error) {
	if err := f.answer(); err != nil {
		return nil, err
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.components, nil
}

func (f *fakeSource) Uptime(context.Context) (source.Uptime, error) {
	if err := f.answer(); err != nil {
		return nil, err
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.uptime, nil
}

func (f *fakeSource) Incidents(context.Context) (source.Incidents, error) {
	if err := f.answer(); err != nil {
		return source.Incidents{}, err
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.incidents, nil
}

func group(statuses ...domain.Status) domain.Group {
	g := domain.Group{Name: "Core"}
	for i, s := range statuses {
		g.Components = append(g.Components, domain.Component{Name: "Core" + string(rune('A'+i)), Status: s})
	}
	g.Status = domain.GroupStatus(g.Components)
	return g
}

func healthy(regions ...string) source.Components {
	out := source.Components{}
	for _, r := range regions {
		out[r] = []domain.Group{group(domain.StatusOperational, domain.StatusOperational)}
	}
	return out
}

var t0 = time.Date(2026, 10, 20, 12, 0, 0, 0, time.UTC)

func testConfig() *config.Config {
	return &config.Config{
		Polling: config.Polling{
			ComponentsInterval: 20 * time.Millisecond, UptimeInterval: 20 * time.Millisecond,
			IncidentsInterval: 20 * time.Millisecond, RequestTimeout: 10 * time.Millisecond,
			StaleAfter: 5 * time.Minute,
		},
		History: config.History{Days: 7},
		Products: []config.Product{
			{ID: "one", Name: "One", PageURL: "https://one.test", Sources: []config.SourceRef{
				{Backend: "b", Cloud: "s1", Regions: []config.RegionRef{{Key: "us", ID: "us", Name: "US"}, {Key: "eu", ID: "eu", Name: "EU"}}},
			}},
			{ID: "two", Name: "Two", PageURL: "https://two.test", Sources: []config.SourceRef{
				{Backend: "b", Cloud: "s2", Regions: []config.RegionRef{{Key: "cp", ID: "us-cp", Name: "US CP"}}},
				{Backend: "b", Cloud: "s3", PageURL: "https://eu.two.test", Regions: []config.RegionRef{{Key: "cp", ID: "eu-cp", Name: "EU CP"}}},
			}},
		},
	}
}

// freshState returns state where every source answered at t0 with healthy
// data, no uptime figures and empty incident history covering the window.
func freshState() map[string]sourceState {
	inc := fetched[source.Incidents]{data: source.Incidents{Items: []domain.Incident{}, CoverageStart: t0.AddDate(0, -6, 0)}, at: t0}
	up := fetched[source.Uptime]{data: source.Uptime{}, at: t0}
	return map[string]sourceState{
		"b/s1": {components: fetched[source.Components]{data: healthy("us", "eu"), at: t0}, uptime: up, incidents: inc},
		"b/s2": {components: fetched[source.Components]{data: healthy("cp"), at: t0}, uptime: up, incidents: inc},
		"b/s3": {components: fetched[source.Components]{data: healthy("cp"), at: t0}, uptime: up, incidents: inc},
	}
}

func params(state map[string]sourceState, now time.Time) buildParams {
	cfg := testConfig()
	return buildParams{products: cfg.Products, state: state, now: now, stale: stalenessOf(cfg.Polling), days: cfg.History.Days}
}
