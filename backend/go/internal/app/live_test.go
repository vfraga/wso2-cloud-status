//go:build live

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

package app

import (
	"context"
	"encoding/json"
	"log/slog"
	"net/http"
	"testing"
	"time"

	"github.com/wso2/wso2-cloud-status/backend/go/internal/aggregator"
	"github.com/wso2/wso2-cloud-status/backend/go/internal/config"
)

// TestLiveUpstream runs the shipped configuration against the real public
// status APIs. It catches upstream contract drift that the captured fixtures
// cannot: every feed of every product must decode (a decode failure shows
// only as a stale kind), and every product must report exactly the regions
// the configuration names. CI runs it nightly, not on pull requests.
func TestLiveUpstream(t *testing.T) {
	cfg, err := config.Load("../../../../config/statusd.yaml")
	if err != nil {
		t.Fatal(err)
	}
	cfg.Server.Addr, cfg.Server.AdminAddr = "127.0.0.1:0", "127.0.0.1:0"
	a, err := New(cfg, slog.New(slog.DiscardHandler), "live-test")
	if err != nil {
		t.Fatal(err)
	}
	if err := a.Listen(t.Context()); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(t.Context(), time.Minute)
	defer cancel()
	go func() { _ = a.Run(ctx) }()
	waitReady(t, "http://"+a.AdminAddr().String()+"/readyz")

	code, body := get(t, "http://"+a.Addr().String()+"/api/v1/summary")
	if code != http.StatusOK {
		t.Fatalf("summary: %d", code)
	}
	var s aggregator.Summary
	if err := json.Unmarshal(body, &s); err != nil {
		t.Fatal(err)
	}
	if len(s.Products) != len(cfg.Products) {
		t.Fatalf("products = %d, want %d", len(s.Products), len(cfg.Products))
	}
	if !s.DataComplete {
		t.Error("summary: data_complete is false")
	}
	for i, p := range s.Products {
		checkLiveProduct(t, p, cfg.Products[i])
	}
}

// checkLiveProduct: every kind answered and current, every configured region
// known, and no region the configuration does not name.
func checkLiveProduct(t *testing.T, p aggregator.ProductSummary, want config.Product) {
	t.Helper()
	regions := 0
	for _, ref := range want.Sources {
		regions += len(ref.Regions)
	}
	if len(p.Regions) != regions {
		t.Errorf("%s: %d regions, want the %d configured (a region key changed upstream?)", p.ID, len(p.Regions), regions)
	}
	if !p.DataComplete {
		t.Errorf("%s: incomplete data from the live API", p.ID)
	}
	for _, r := range p.Regions {
		if !r.Status.Known() {
			t.Errorf("%s/%s: status unknown", p.ID, r.ID)
		}
	}
	if p.Stale != (aggregator.Stale{}) || p.CheckedAt.Components == nil || p.CheckedAt.Incidents == nil || p.CheckedAt.Uptime == nil {
		t.Errorf("%s: stale %+v; a feed failed to fetch or decode (an upstream format change?)", p.ID, p.Stale)
	}
}
