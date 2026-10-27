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

// This file is an external test package: it compares the shipped files with
// an adapter's limits, and the adapter imports config.
package config_test

import (
	"path/filepath"
	"testing"

	"github.com/wso2/wso2-cloud-status/backend/go/internal/config"
	"github.com/wso2/wso2-cloud-status/backend/go/internal/source/legacyapi"
)

// TestThrottleEndsBeforeDataGoesStale: a 429 holds a CSM backend for at
// most legacyapi.MaxRetryAfter, which must stay below polling.stale_after in
// every shipped file, or a long throttle would leave the page without data.
func TestThrottleEndsBeforeDataGoesStale(t *testing.T) {
	t.Setenv("FRONT_DOOR_ID", "00000000-0000-0000-0000-000000000001")
	files, err := filepath.Glob("../../../../config/*.yaml")
	if err != nil || len(files) < 2 {
		t.Fatalf("shipped files = %v, %v; want both in config/", files, err)
	}
	for _, path := range files {
		cfg, err := config.Load(path)
		if err != nil {
			t.Fatal(err)
		}
		if legacyapi.MaxRetryAfter >= cfg.Polling.StaleAfter {
			t.Errorf("%s: polling.stale_after %s is not above legacyapi.MaxRetryAfter %s",
				path, cfg.Polling.StaleAfter, legacyapi.MaxRetryAfter)
		}
	}
}
