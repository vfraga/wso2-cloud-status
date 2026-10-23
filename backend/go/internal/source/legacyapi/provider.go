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

package legacyapi

import (
	"fmt"
	"maps"
	"slices"

	"github.com/wso2/wso2-cloud-status/backend/go/internal/config"
	"github.com/wso2/wso2-cloud-status/backend/go/internal/source"
)

// Type is the backend type name this adapter registers under.
const Type = "legacy-status-api"

type provider struct {
	client *Client
}

func (p provider) Source(cloud string) source.Source {
	return NewSource(p.client, cloud)
}

// NewProvider is the source.Factory for the legacy status API. The adapter
// takes no options.
func NewProvider(_ string, b config.Backend, env source.Env) (source.Provider, error) {
	if len(b.Options) > 0 {
		return nil, fmt.Errorf("legacyapi: unknown options %v", slices.Sorted(maps.Keys(b.Options)))
	}
	loc, err := b.Location()
	if err != nil {
		return nil, err
	}
	client, err := NewClient(b.BaseURL, env.HTTPClient, loc, env.UserAgent)
	if err != nil {
		return nil, err
	}
	return provider{client: client}, nil
}
