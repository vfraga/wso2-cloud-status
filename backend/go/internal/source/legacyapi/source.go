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
	"context"
	"errors"
	"fmt"

	"github.com/wso2/wso2-cloud-status/backend/go/internal/source"
)

// ErrEmptyResponse is wrapped by errors for a response that is {} or null.
// The upstream answered without data: that is a failed fetch, so the last
// good data stays, not news that every region or month is gone.
var ErrEmptyResponse = errors.New("legacyapi: empty response")

// Source reads one cloud (for example "choreo" or "asgardeo") from a backend.
type Source struct {
	client *Client
	cloud  string
}

var _ source.Source = (*Source)(nil)

// NewSource binds a client to one cloud key.
func NewSource(client *Client, cloud string) *Source {
	return &Source{client: client, cloud: cloud}
}

// Components returns each region's component groups.
func (s *Source) Components(ctx context.Context) (source.Components, error) {
	var raw map[string][]wireGroup
	if err := s.client.getJSON(ctx, "monitors", s.cloud, &raw); err != nil {
		return nil, err
	}
	if len(raw) == 0 {
		return nil, s.empty("monitors")
	}
	if err := measureComponents(raw).err; err != nil {
		return nil, err
	}
	return toComponents(raw), nil
}

// Uptime returns each region's trailing uptime windows.
func (s *Source) Uptime(ctx context.Context) (source.Uptime, error) {
	var raw map[string][]wireAvailability
	if err := s.client.getJSON(ctx, "availabilities", s.cloud, &raw); err != nil {
		return nil, err
	}
	if len(raw) == 0 {
		return nil, s.empty("availabilities")
	}
	if err := measureUptime(raw).err; err != nil {
		return nil, err
	}
	return toRegionUptime(raw), nil
}

// Incidents returns the incident history, newest first.
func (s *Source) Incidents(ctx context.Context) (source.Incidents, error) {
	var raw map[string]wireMonth
	if err := s.client.getJSON(ctx, "incidents", s.cloud, &raw); err != nil {
		return source.Incidents{}, err
	}
	if len(raw) == 0 {
		return source.Incidents{}, s.empty("incidents")
	}
	return toIncidents(raw, s.client.location)
}

func (s *Source) empty(path string) error {
	return fmt.Errorf("%w: GET %s?cloud=%s returned {} or null", ErrEmptyResponse, path, s.cloud)
}
