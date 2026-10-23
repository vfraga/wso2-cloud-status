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

package source

import (
	"fmt"
	"maps"
	"net/http"
	"slices"

	"github.com/wso2/wso2-cloud-status/backend/go/internal/config"
)

// Env carries the shared dependencies an adapter may use.
type Env struct {
	HTTPClient *http.Client
	UserAgent  string
}

// Provider serves the clouds of one configured backend.
type Provider interface {
	Source(cloud string) Source
}

// Factory builds a Provider from one backend's configuration. It must
// reject options it does not understand.
type Factory func(name string, backend config.Backend, env Env) (Provider, error)

// Registry maps backend types to factories. Adding a data source (CSM, a
// synthetic monitor, a vendor status API) is one Register call; the
// aggregator, the API and the frontend do not change.
type Registry struct {
	factories map[string]Factory
}

// NewRegistry returns an empty registry.
func NewRegistry() *Registry {
	return &Registry{factories: map[string]Factory{}}
}

// Register adds a backend type. Registering a type twice is a programming
// error and panics at startup.
func (r *Registry) Register(typ string, f Factory) {
	if _, dup := r.factories[typ]; dup {
		panic(fmt.Sprintf("source: backend type %q registered twice", typ))
	}
	r.factories[typ] = f
}

// Types lists the registered backend types, sorted.
func (r *Registry) Types() []string {
	return slices.Sorted(maps.Keys(r.factories))
}

// Provider builds the provider for one backend.
func (r *Registry) Provider(name string, backend config.Backend, env Env) (Provider, error) {
	f, ok := r.factories[backend.Type]
	if !ok {
		return nil, fmt.Errorf("source: backend %s has unknown type %q (known: %v)", name, backend.Type, r.Types())
	}
	p, err := f(name, backend, env)
	if err != nil {
		return nil, fmt.Errorf("source: backend %s: %w", name, err)
	}
	return p, nil
}
