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
	"errors"
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
// adapter is one more Register line.
func DefaultRegistry() *source.Registry {
	r := source.NewRegistry()
	r.Register(legacyapi.Type, legacyapi.NewProvider)
	r.Register(legacyapi.CSMType, legacyapi.NewCSMProvider)
	return r
}

// built is a backend's provider and the definition it was built from.
type built struct {
	definition string
	provider   source.Provider
}

// buildBindings creates one source per product source reference, through
// its backend's provider, and reports every backend its adapter refuses.
// A backend whose definition is unchanged from prev keeps its provider, so
// the clouds a reload adds share the token, throttling circuit and request
// slots of the clouds already bound; a new or changed backend gets a new
// one. Every backend goes through its adapter either way, so a reload
// checks the file as a start does. It returns the providers the bindings
// use. A reference to a backend that does not exist gets no source;
// validation reports it.
func buildBindings(cfg *config.Config, reg *source.Registry, env source.Env, prev map[string]built) (map[string]aggregator.Binding, map[string]built, error) {
	providers := make(map[string]built, len(cfg.Backends))
	var errs []error
	for _, name := range slices.Sorted(maps.Keys(cfg.Backends)) {
		p, err := reg.Provider(name, cfg.Backends[name], env)
		if err != nil {
			errs = append(errs, err)
			continue
		}
		def := definition(cfg.Backends[name])
		if kept, ok := prev[name]; ok && kept.definition == def {
			providers[name] = kept
			continue
		}
		providers[name] = built{definition: def, provider: p}
	}
	if len(errs) > 0 {
		return nil, nil, errors.Join(errs...)
	}
	bindings := map[string]aggregator.Binding{}
	for _, p := range cfg.Products {
		for _, ref := range p.Sources {
			b, ok := providers[ref.Backend]
			if !ok {
				continue
			}
			bindings[aggregator.SourceKey(ref)] = aggregator.Binding{
				Source:      b.provider.Source(ref.Cloud),
				Fingerprint: fingerprint(cfg.Backends[ref.Backend], ref.Cloud),
			}
		}
	}
	return bindings, providers, nil
}

// definition identifies everything that defines a backend: its type, base
// URL, time zone and options. It is hashed because options may hold
// secrets.
func definition(b config.Backend) string {
	var sb strings.Builder
	fmt.Fprintf(&sb, "%s\x00%s\x00%s", b.Type, b.BaseURL, b.Timezone)
	for _, k := range slices.Sorted(maps.Keys(b.Options)) {
		fmt.Fprintf(&sb, "\x00%s=%s", k, b.Options[k])
	}
	sum := sha256.Sum256([]byte(sb.String()))
	return hex.EncodeToString(sum[:])
}

// fingerprint identifies everything that determines a source's data: its
// backend's definition and its cloud.
func fingerprint(b config.Backend, cloud string) string {
	sum := sha256.Sum256([]byte(definition(b) + "\x00" + cloud))
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
