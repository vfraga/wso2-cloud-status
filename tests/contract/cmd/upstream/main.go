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
//
// It answers as the legacy status API (/api/v1/<kind>?cloud=) and as CSM's
// cloud-status API (/cloud-status/<kind>?cloud=, in ServiceNow's envelope,
// with a bearer token from /oauth2/token for the client id and secret it is
// started with), as csm-integration-service serves it in cs-tools 2c2711cf.
package main

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"flag"
	"log/slog"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"time"
)

var cloudName = regexp.MustCompile(`^[a-z0-9-]+$`)

func main() {
	addr := flag.String("addr", "127.0.0.1:18090", "listen address")
	dir := flag.String("dir", "testdata/upstream", "fixture directory")
	clientID := flag.String("client-id", "contract", "CSM client id the token endpoint accepts")
	flag.Parse()
	// The secret comes from the environment, as statusd reads it.
	csm := &fakeCSM{id: *clientID, secret: os.Getenv("CSM_CLIENT_SECRET"), tokens: map[string]bool{}}

	srv := &http.Server{Addr: *addr, Handler: handler(*dir, csm), ReadHeaderTimeout: 5 * time.Second}
	slog.Info("replaying fixtures", slog.String("addr", *addr), slog.String("dir", *dir))
	if err := srv.ListenAndServe(); !errors.Is(err, http.ErrServerClosed) {
		slog.Error("stopped", slog.Any("error", err))
		os.Exit(1)
	}
}

func handler(dir string, csm *fakeCSM) http.Handler {
	fixture := func(w http.ResponseWriter, r *http.Request) ([]byte, bool) {
		endpoint, cloud := r.PathValue("endpoint"), r.URL.Query().Get("cloud")
		if !cloudName.MatchString(cloud) || strings.ContainsAny(endpoint, "./") {
			http.NotFound(w, r)
			return nil, false
		}
		body, err := os.ReadFile(filepath.Join(dir, cloud+"."+endpoint+".json")) //nolint:gosec // Inputs are validated above; test tool.
		if err != nil {
			http.NotFound(w, r)
			return nil, false
		}
		return body, true
	}
	mux := http.NewServeMux()
	mux.HandleFunc("GET /api/v1/{endpoint}", func(w http.ResponseWriter, r *http.Request) {
		if body, ok := fixture(w, r); ok {
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write(body)
		}
	})
	mux.HandleFunc("POST /oauth2/token", csm.issue)
	mux.HandleFunc("GET /cloud-status/{endpoint}", func(w http.ResponseWriter, r *http.Request) {
		if !csm.accepts(r) {
			writeJSON(w, http.StatusUnauthorized, map[string]string{"message": "Invalid Credentials"})
			return
		}
		body, ok := fixture(w, r)
		if !ok {
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"result": map[string]any{
			"code": 0, "message": "success", "cloud": r.URL.Query().Get("cloud"), "data": json.RawMessage(body),
		}})
	})
	return mux
}

// fakeCSM issues client-credentials tokens and checks them on reads.
type fakeCSM struct {
	id, secret string
	mu         sync.Mutex
	tokens     map[string]bool
}

func (c *fakeCSM) issue(w http.ResponseWriter, r *http.Request) {
	id, secret, ok := r.BasicAuth()
	if !ok || c.secret == "" || id != c.id || secret != c.secret || r.FormValue("grant_type") != "client_credentials" {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "invalid_client"})
		return
	}
	raw := make([]byte, 16)
	_, _ = rand.Read(raw)
	token := hex.EncodeToString(raw)
	c.mu.Lock()
	c.tokens[token] = true
	c.mu.Unlock()
	writeJSON(w, http.StatusOK, map[string]any{"access_token": token, "token_type": "Bearer", "expires_in": 3600})
}

func (c *fakeCSM) accepts(r *http.Request) bool {
	token, ok := strings.CutPrefix(r.Header.Get("Authorization"), "Bearer ")
	c.mu.Lock()
	defer c.mu.Unlock()
	return ok && c.tokens[token]
}

func writeJSON(w http.ResponseWriter, status int, body any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(body)
}
