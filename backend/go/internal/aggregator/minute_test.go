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
	"encoding/json"
	"testing"
	"time"

	"github.com/wso2/wso2-cloud-status/backend/go/internal/config"
	"github.com/wso2/wso2-cloud-status/backend/go/internal/domain"
	"github.com/wso2/wso2-cloud-status/backend/go/internal/source"
)

// TestBodiesChangeOnlyWithTheMinute: with the shipped polling settings and
// no status change, each source's polls land at their own second, yet every
// body changes once a minute, when generated_at does, and at no other build.
// One product has an open incident that started at a second offset, so its
// history minutes grow too.
func TestBodiesChangeOnlyWithTheMinute(t *testing.T) {
	t.Parallel()
	cfg := testConfig()
	cfg.Polling = config.Polling{
		ComponentsInterval: 30 * time.Second, UptimeInterval: 5 * time.Minute, IncidentsInterval: 30 * time.Second,
		RequestTimeout: 5 * time.Second, StaleAfter: 5 * time.Minute,
	}
	bindings, raw := fakes()
	coverage := t0.AddDate(0, -6, 0)
	for _, f := range raw {
		f.set(func(f *fakeSource) {
			f.incidents = source.Incidents{Items: []domain.Incident{}, CoverageStart: coverage}
		})
	}
	open := domain.Incident{ID: "open", Title: "Slow builds", Impact: domain.StatusDegraded, State: "investigating", StartedAt: t0.Add(-40 * time.Minute).Add(20 * time.Second)}
	raw["b/s2"].set(func(f *fakeSource) { f.incidents.Items = []domain.Incident{open} })

	now := t0.Add(-3 * time.Second)
	var bodies []string
	agg, err := New(cfg, bindings, Options{
		Clock: func() time.Time { return now },
		Publish: func(b Built) error {
			raw, err := json.Marshal([]any{b.Summary, b.Products["one"], b.Products["two"], b.Incidents})
			bodies = append(bodies, string(raw))
			return err
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	agg.RefreshAll(ctx)
	// Each source polls components and incidents every 30 s and uptime
	// every 5 min, at its own offset.
	offsets := map[string]int{"b/s1": 7, "b/s2": 13, "b/s3": 29}
	minutes := []time.Time{minuteOf(now)}
	for second := 1; second <= 240; second++ {
		now = t0.Add(-3 * time.Second).Add(time.Duration(second) * time.Second)
		for key, offset := range offsets {
			if (second-offset)%30 == 0 {
				_ = agg.poll(ctx, key, KindComponents)
				_ = agg.poll(ctx, key, KindIncidents)
			}
			if (second-offset)%300 == 0 {
				_ = agg.poll(ctx, key, KindUptime)
			}
		}
		agg.Rebuild()
		minutes = append(minutes, minuteOf(now))
	}
	changes := 0
	for i := 1; i < len(bodies); i++ {
		changed, newMinute := bodies[i] != bodies[i-1], !minutes[i].Equal(minutes[i-1])
		if changed != newMinute {
			t.Fatalf("build at %s: body changed %v, minute changed %v; want a change exactly when the minute changes",
				t0.Add(-3*time.Second).Add(time.Duration(i)*time.Second).Format(time.TimeOnly), changed, newMinute)
		}
		if changed {
			changes++
		}
	}
	if changes != 4 {
		t.Fatalf("%d changes in 4 minutes, want 4", changes)
	}
}
