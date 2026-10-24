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

// Package httpapi serves the public read API from pre-encoded snapshots.
package httpapi

import (
	"bytes"
	"compress/gzip"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"sync/atomic"
	"time"

	"github.com/wso2/wso2-cloud-status/backend/go/internal/aggregator"
)

// encoded is one response body, encoded and compressed once per build
// instead of once per request. Each body has its own strong ETag: the plain
// body's hash, and for the gzip body the same with "-gz" appended.
type encoded struct {
	body   []byte
	gz     []byte
	etag   string
	gzETag string
	// modified is when this body last changed; it increases with every
	// change, so two changes within one second can take it past the clock
	// (lastModified). Azure Front Door revalidates with If-Modified-Since
	// only (it ignores ETags). Responses send it capped at their Date.
	modified time.Time
}

// snapshot is an immutable set of encoded responses.
type snapshot struct {
	routes map[string]*encoded
	ready  bool
}

// Store holds the current snapshot. Readers never block writers.
type Store struct {
	current atomic.Pointer[snapshot]
	// Clock is used for Last-Modified and Date; nil means time.Now.
	Clock func() time.Time
}

func (s *Store) now() time.Time {
	if s.Clock != nil {
		return s.Clock()
	}
	return time.Now()
}

// Route keys.
const (
	routeSummary   = "summary"
	routeIncidents = "incidents"
	routeProduct   = "products/"
)

// Publish encodes a build and swaps it in atomically.
func (s *Store) Publish(b aggregator.Built) error {
	published := s.now().UTC().Truncate(time.Second)
	prev := s.current.Load()
	snap := &snapshot{routes: make(map[string]*encoded, len(b.Products)+2), ready: b.Ready}
	add := func(key string, v any) error {
		enc, err := encode(v)
		if err != nil {
			return fmt.Errorf("httpapi: encode %s: %w", key, err)
		}
		enc.modified = published
		if prev != nil {
			if old, ok := prev.routes[key]; ok {
				enc.modified = lastModified(old, enc.etag, published)
			}
		}
		snap.routes[key] = enc
		return nil
	}
	if err := add(routeSummary, b.Summary); err != nil {
		return err
	}
	if err := add(routeIncidents, b.Incidents); err != nil {
		return err
	}
	for id, p := range b.Products {
		if err := add(routeProduct+id, p); err != nil {
			return err
		}
	}
	s.current.Store(snap)
	return nil
}

// lastModified keeps the previous time while the body is unchanged. A changed
// body is always at least a second newer than the previous one: a CDN that
// revalidates with If-Modified-Since alone would otherwise keep the first of
// two bodies published within one second. That can put it ahead of the
// clock; responses cap what they send at their Date (sentLastModified).
func lastModified(old *encoded, etag string, published time.Time) time.Time {
	if old.etag == etag {
		return old.modified
	}
	if next := old.modified.Add(time.Second); next.After(published) {
		return next
	}
	return published
}

// sentLastModified is the Last-Modified a response sent at now carries: the
// body's time, or the response's Date when that is earlier. RFC 9110 section
// 8.8.2.1 forbids a Last-Modified later than Date. If-Modified-Since is still
// compared with the body's own time, so a copy whose Last-Modified was capped
// gets the newer body at its next revalidation; the value sent never goes
// backwards, because the body's time and the clock both only move forward.
func sentLastModified(enc *encoded, now time.Time) time.Time {
	if date := now.UTC().Truncate(time.Second); enc.modified.After(date) {
		return date
	}
	return enc.modified
}

func encode(v any) (*encoded, error) {
	body, err := json.Marshal(v)
	if err != nil {
		return nil, err
	}
	var buf bytes.Buffer
	zw, err := gzip.NewWriterLevel(&buf, gzip.BestCompression)
	if err != nil {
		return nil, err
	}
	if _, err := zw.Write(body); err != nil {
		return nil, err
	}
	if err := zw.Close(); err != nil {
		return nil, err
	}
	sum := sha256.Sum256(body)
	hash := hex.EncodeToString(sum[:12])
	return &encoded{body: body, gz: buf.Bytes(), etag: `"` + hash + `"`, gzETag: `"` + hash + `-gz"`}, nil
}
