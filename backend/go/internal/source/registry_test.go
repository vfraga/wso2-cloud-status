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
	"context"
	"errors"
	"strings"
	"testing"

	"github.com/wso2/wso2-cloud-status/backend/go/internal/config"
)

type stubSource struct{ cloud string }

func (stubSource) Components(context.Context) (Components, error) { return Components{}, nil }
func (stubSource) Uptime(context.Context) (Uptime, error)         { return Uptime{}, nil }
func (stubSource) Incidents(context.Context) (Incidents, error)   { return Incidents{}, nil }

type stubProvider struct{}

func (stubProvider) Source(cloud string) Source { return stubSource{cloud: cloud} }

func TestRegistry(t *testing.T) {
	t.Parallel()
	r := NewRegistry()
	r.Register("b-type", func(string, config.Backend, Env) (Provider, error) { return stubProvider{}, nil })
	r.Register("a-type", func(string, config.Backend, Env) (Provider, error) { return nil, errors.New("bad options") })
	if got := r.Types(); len(got) != 2 || got[0] != "a-type" {
		t.Fatalf("Types = %v, want sorted", got)
	}
	p, err := r.Provider("x", config.Backend{Type: "b-type"}, Env{})
	if err != nil || p.Source("c").(stubSource).cloud != "c" {
		t.Fatalf("Provider: %v", err)
	}
	if _, err := r.Provider("x", config.Backend{Type: "a-type"}, Env{}); err == nil || !strings.Contains(err.Error(), "backend x: bad options") {
		t.Fatalf("factory error not wrapped: %v", err)
	}
	if _, err := r.Provider("x", config.Backend{Type: "nope"}, Env{}); err == nil || !strings.Contains(err.Error(), "[a-type b-type]") {
		t.Fatalf("unknown type error must list known types: %v", err)
	}
	defer func() {
		if recover() == nil {
			t.Fatal("duplicate registration must panic")
		}
	}()
	r.Register("a-type", nil)
}
