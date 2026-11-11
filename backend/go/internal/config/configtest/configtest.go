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

// Package configtest reads configuration files for the tests of other
// packages.
package configtest

import (
	"testing"

	"github.com/wso2/wso2-cloud-status/backend/go/internal/config"
)

// Load reads, defaults and validates the configuration file at path,
// failing the test on any problem. The service itself reads a file with
// config.Read, applies config.ApplyEnvOverrides, then validates it together
// with its sources' adapters.
func Load(t testing.TB, path string) *config.Config {
	t.Helper()
	cfg, _, err := config.Read(path)
	if err != nil {
		t.Fatal(err)
	}
	if err := cfg.Validate(); err != nil {
		t.Fatal(err)
	}
	return cfg
}
