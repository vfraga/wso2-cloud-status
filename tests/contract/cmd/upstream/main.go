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

// Command upstream replays captured status API responses so any backend
// implementation can be contract-tested against identical upstream data.
package main

import (
	"errors"
	"flag"
	"log/slog"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"
)

var cloudName = regexp.MustCompile(`^[a-z0-9-]+$`)

func main() {
	addr := flag.String("addr", "127.0.0.1:18090", "listen address")
	dir := flag.String("dir", "testdata/upstream", "fixture directory")
	flag.Parse()

	srv := &http.Server{Addr: *addr, Handler: handler(*dir), ReadHeaderTimeout: 5 * time.Second}
	slog.Info("replaying fixtures", slog.String("addr", *addr), slog.String("dir", *dir))
	if err := srv.ListenAndServe(); !errors.Is(err, http.ErrServerClosed) {
		slog.Error("stopped", slog.Any("error", err))
		os.Exit(1)
	}
}

func handler(dir string) http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /api/v1/{endpoint}", func(w http.ResponseWriter, r *http.Request) {
		endpoint, cloud := r.PathValue("endpoint"), r.URL.Query().Get("cloud")
		if !cloudName.MatchString(cloud) || strings.ContainsAny(endpoint, "./") {
			http.NotFound(w, r)
			return
		}
		body, err := os.ReadFile(filepath.Join(dir, cloud+"."+endpoint+".json")) //nolint:gosec // Inputs are validated above; test tool.
		if err != nil {
			http.NotFound(w, r)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write(body) //nolint:gosec // Serves fixed fixture files as JSON; no request data is reflected.
	})
	return mux
}
