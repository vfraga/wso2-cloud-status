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
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"maps"
	"net/http"
	"slices"
	"strings"

	"github.com/wso2/wso2-cloud-status/backend/go/internal/aggregator"
	"github.com/wso2/wso2-cloud-status/backend/go/internal/config"
	"github.com/wso2/wso2-cloud-status/backend/go/internal/source"
	"github.com/wso2/wso2-cloud-status/backend/go/internal/source/legacyapi"
)

// DefaultRegistry lists every data source adapter the service ships. A new
// adapter (CSM) is one more Register line.
func DefaultRegistry() *source.Registry {
	r := source.NewRegistry()
	r.Register(legacyapi.Type, legacyapi.NewProvider)
	return r
}

// buildBindings creates one source per product source reference, through
// the backend's adapter.
func buildBindings(cfg *config.Config, reg *source.Registry, env source.Env) (map[string]aggregator.Binding, error) {
	providers := make(map[string]source.Provider, len(cfg.Backends))
	for _, name := range slices.Sorted(maps.Keys(cfg.Backends)) {
		p, err := reg.Provider(name, cfg.Backends[name], env)
		if err != nil {
			return nil, err
		}
		providers[name] = p
	}
	bindings := map[string]aggregator.Binding{}
	for _, p := range cfg.Products {
		for _, ref := range p.Sources {
			bindings[aggregator.SourceKey(ref)] = aggregator.Binding{
				Source:      providers[ref.Backend].Source(ref.Cloud),
				Fingerprint: fingerprint(cfg.Backends[ref.Backend], ref.Cloud),
			}
		}
	}
	return bindings, nil
}

// fingerprint identifies everything that determines a source's data. It is
// hashed because options may hold secrets.
func fingerprint(b config.Backend, cloud string) string {
	var sb strings.Builder
	fmt.Fprintf(&sb, "%s\x00%s\x00%s\x00%s", b.Type, b.BaseURL, b.Timezone, cloud)
	for _, k := range slices.Sorted(maps.Keys(b.Options)) {
		fmt.Fprintf(&sb, "\x00%s=%s", k, b.Options[k])
	}
	sum := sha256.Sum256([]byte(sb.String()))
	return hex.EncodeToString(sum[:])
}

// upstreamClient is shared by every adapter. Each poll's context carries
// polling.request_timeout as its deadline, so a reloaded timeout applies at
// the next poll; the transport keeps net/http's defaults rather than a copy
// of the timeout taken at startup. It follows no redirect (refuseRedirect).
func upstreamClient() *http.Client {
	t := http.DefaultTransport.(*http.Transport).Clone() //nolint:forcetypeassert // DefaultTransport is always *http.Transport.
	t.MaxIdleConnsPerHost = 8
	return &http.Client{Transport: t, CheckRedirect: refuseRedirect}
}

// refuseRedirect makes every 3xx answer a failed fetch. Following one could
// switch an https base URL to plain http, where an on-path attacker can
// serve fabricated statuses, and Go resends credentials to the same host
// over either scheme. The error, which the failed-fetch log line carries,
// names where the redirect pointed, so the configured base URL can be
// corrected.
func refuseRedirect(req *http.Request, _ []*http.Request) error {
	return fmt.Errorf("app: upstream redirect to %s refused; set the backend's base_url to the final address", req.URL.Redacted())
}
