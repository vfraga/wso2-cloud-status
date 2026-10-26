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

// Package legacyapi reads the status API behind the existing per-product
// status pages (api.status.cloudservices.wso2.com and api.status.asgardeo.io).
//
// It is the interim data source until the CSM integration exists; both
// implement source.Source.
package legacyapi

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"time"
)

// maxBody caps how much of a response we read. The largest real response is
// about 12 KiB, and the limits in wire.go bound what an answer may hold; a
// response near this cap is a fault, not data.
const maxBody = 1 << 20

// ErrUnexpectedStatus is wrapped by errors for non-200 responses.
var ErrUnexpectedStatus = errors.New("legacyapi: unexpected HTTP status")

// Client calls one status API backend.
type Client struct {
	base      *url.URL
	http      *http.Client
	location  *time.Location
	userAgent string
}

// NewClient returns a client for the backend at baseURL. Timestamps in
// incident responses carry no zone; they are read in loc.
func NewClient(baseURL string, httpClient *http.Client, loc *time.Location, userAgent string) (*Client, error) {
	base, err := url.Parse(baseURL)
	if err != nil {
		return nil, fmt.Errorf("legacyapi: parse base URL: %w", err)
	}
	if base.Scheme != "https" && base.Scheme != "http" {
		return nil, fmt.Errorf("legacyapi: base URL %q must be http or https", baseURL)
	}
	if httpClient == nil {
		return nil, errors.New("legacyapi: nil http client")
	}
	if loc == nil {
		loc = time.UTC
	}
	return &Client{base: base, http: httpClient, location: loc, userAgent: userAgent}, nil
}

func (c *Client) endpoint(path, cloud string) string {
	u := c.base.JoinPath("api", "v1", path)
	u.RawQuery = url.Values{"cloud": {cloud}}.Encode()
	return u.String()
}

func (c *Client) getJSON(ctx context.Context, path, cloud string, out any) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, c.endpoint(path, cloud), nil)
	if err != nil {
		return fmt.Errorf("legacyapi: build request: %w", err)
	}
	req.Header.Set("Accept", "application/json")
	req.Header.Set("User-Agent", c.userAgent)

	resp, err := c.http.Do(req)
	if err != nil {
		return fmt.Errorf("legacyapi: GET %s: %w", path, err)
	}
	defer func() { _ = resp.Body.Close() }()

	body := io.LimitReader(resp.Body, maxBody)
	if resp.StatusCode != http.StatusOK {
		_, _ = io.Copy(io.Discard, body)
		return fmt.Errorf("%w: GET %s?cloud=%s returned %d", ErrUnexpectedStatus, path, cloud, resp.StatusCode)
	}
	if err := json.NewDecoder(body).Decode(out); err != nil {
		return fmt.Errorf("legacyapi: decode %s?cloud=%s: %w", path, cloud, err)
	}
	return nil
}
