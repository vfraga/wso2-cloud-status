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

// Package testutil holds what the tests of several packages share.
package testutil

import (
	"os"
	"path/filepath"
)

// RepoPath joins rel to the repository root: the nearest directory at or
// above the working directory (a test's package directory) that holds
// config/statusd.yaml. Tests read the repository's shared files (the
// shipped configuration, fixtures, alert rules) through it, so moving a
// package or the whole backend changes no path. It panics when there is no
// such directory: the test cannot run outside the repository.
func RepoPath(rel ...string) string {
	dir, err := os.Getwd()
	if err != nil {
		panic(err)
	}
	for {
		if _, err := os.Stat(filepath.Join(dir, "config", "statusd.yaml")); err == nil {
			return filepath.Join(append([]string{dir}, rel...)...)
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			panic("testutil: no config/statusd.yaml above the working directory")
		}
		dir = parent
	}
}
