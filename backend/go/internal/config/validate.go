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

package config

import (
	"maps"
	"net"
	"net/url"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"time"
	"unicode"
)

var slug = regexp.MustCompile(`^[a-z0-9]+(-[a-z0-9]+)*$`)

// Bounds of the polling and shutdown durations.
const (
	minInterval        = 5 * time.Second
	minRequestTimeout  = 100 * time.Millisecond
	minShutdownTimeout = time.Second
	maxShutdownTimeout = time.Minute
	minHistoryDays     = 1
	// browserPoll is how often the page polls the summary and a product
	// (frontend/src/config.ts; fallbackProducts.test.ts keeps the two equal).
	browserPoll = 30 * time.Second
)

// Validate reports every problem in the configuration.
func (c *Config) Validate() error {
	var e errs
	c.validateServer(&e)
	if c.Reload.Interval() < 0 || (c.Reload.Interval() > 0 && c.Reload.Interval() < time.Second) {
		e.addf("reload.watch_interval must be 0 (off) or at least 1s, got %s", c.Reload.Interval())
	}
	c.validatePolling(&e)
	// The history strip shows up to 90 of these UTC days; fewer make it shorter.
	if c.History.Days < minHistoryDays || c.History.Days > 366 {
		e.addf("history.days must be between %d and 366, got %d", minHistoryDays, c.History.Days)
	}
	c.validateBackends(&e)
	c.validateProducts(&e)
	return e.join()
}

func (c *Config) validateServer(e *errs) {
	s := c.Server
	for _, a := range []struct{ name, addr string }{{"server.addr", s.Addr}, {"server.admin_addr", s.AdminAddr}} {
		if !validAddr(a.addr) {
			e.addf("%s must be host:port with an IP address or no host and a port from 0 to 65535, got %q", a.name, a.addr)
		}
	}
	if listenersClash(s.Addr, s.AdminAddr) {
		e.addf("server.addr and server.admin_addr must differ, but %q and %q take the same port", s.Addr, s.AdminAddr)
	}
	if s.MaxInFlight < 1 {
		e.addf("server.max_in_flight must be at least 1, got %d", s.MaxInFlight)
	}
	// Shorter cuts the requests in flight at every deploy; longer only
	// delays a deploy, since responses take milliseconds.
	if s.ShutdownTimeout < minShutdownTimeout || s.ShutdownTimeout > maxShutdownTimeout {
		e.addf("server.shutdown_timeout must be between %s and %s, got %s", minShutdownTimeout, maxShutdownTimeout, s.ShutdownTimeout)
	}
	validateRequiredHeaders(e, s.RequiredHeaders)
	c.validateCacheControl(e)
}

// listenersClash reports whether two listen addresses take the same port:
// the same port number, other than 0 (any free port), on the same IP
// address (::ffff:127.0.0.1 is 127.0.0.1) or with either on every
// interface. validAddr has made every host empty or an IP address.
func listenersClash(a, b string) bool {
	hostA, portA, okA := splitListen(a)
	hostB, portB, okB := splitListen(b)
	if !okA || !okB || portA != portB || portA == 0 {
		return false
	}
	ipA, ipB := net.ParseIP(hostA), net.ParseIP(hostB)
	everywhere := func(host string, ip net.IP) bool { return host == "" || ip.IsUnspecified() }
	return everywhere(hostA, ipA) || everywhere(hostB, ipB) || (ipA != nil && ipA.Equal(ipB))
}

// splitListen splits a listen address into its host and port number.
func splitListen(addr string) (host string, port int, ok bool) {
	host, p, err := net.SplitHostPort(addr)
	if err != nil {
		return "", 0, false
	}
	port, err = strconv.Atoi(p)
	return host, port, err == nil
}

// validateCacheControl checks server.cache_control against the page's poll
// and the staleness limit. A CDN copy
// kept for max-age plus stale-while-revalidate at or past the browser's poll
// hands each poll the copy from before the previous one, so every change
// reaches readers a poll late. A copy served on error after
// polling.stale_after arrives already stale, so every reader sees "Status
// unavailable". Both cache settings may use only the directives those rules
// read (cacheSeconds).
func (c *Config) validateCacheControl(e *errs) {
	cacheSeconds(e, "server.not_found_cache_control", c.Server.NotFoundCacheControl)
	seconds := cacheSeconds(e, "server.cache_control", c.Server.CacheControl)
	maxAge, window := seconds["max-age"], seconds["max-age"]+seconds["stale-while-revalidate"]
	if maxAge == 0 || time.Duration(window)*time.Second >= browserPoll {
		e.addf("server.cache_control: max-age must be above 0 and, with stale-while-revalidate, under %s (the page's poll), got %d and %d",
			browserPoll, maxAge, seconds["stale-while-revalidate"])
	}
	if time.Duration(seconds["stale-if-error"])*time.Second > c.Polling.StaleAfter {
		e.addf("server.cache_control: stale-if-error must be at most polling.stale_after (%s), got %d",
			c.Polling.StaleAfter, seconds["stale-if-error"])
	}
}

// timedDirectives are the Cache-Control directives the cache rules read,
// besides "public". Any other directive could set a lifetime the rules do
// not see (s-maxage sets the CDN's), and a cache may obey either copy of a
// repeated one, so both are rejected.
var timedDirectives = map[string]bool{"max-age": true, "stale-while-revalidate": true, "stale-if-error": true}

// cacheSeconds reads a Cache-Control value into seconds per timed
// directive, and reports under key anything the cache rules cannot read.
func cacheSeconds(e *errs, key, value string) map[string]int {
	seconds := map[string]int{}
	seen := map[string]bool{}
	for directive := range strings.SplitSeq(value, ",") {
		name, arg, _ := strings.Cut(strings.TrimSpace(directive), "=")
		name = strings.ToLower(name)
		if seen[name] {
			e.addf("%s: %s is given twice", key, name)
			continue
		}
		seen[name] = true
		if name == "public" && arg == "" {
			continue
		}
		if !timedDirectives[name] {
			e.addf("%s: %q is not public, max-age, stale-while-revalidate or stale-if-error", key, strings.TrimSpace(directive))
			continue
		}
		n, err := strconv.Atoi(arg)
		if err != nil || n < 0 {
			e.addf("%s: %s must be a number of seconds, got %q", key, name, arg)
			continue
		}
		seconds[name] = n
	}
	return seconds
}

func validateRequiredHeaders(e *errs, headers map[string]string) {
	for _, name := range slices.Sorted(maps.Keys(headers)) {
		if !headerName.MatchString(name) || !validHeaderValue(headers[name]) {
			e.addf("server.required_headers: %q needs a valid header name and a value without surrounding spaces or control characters", name)
		}
	}
}

var headerName = regexp.MustCompile(`^[A-Za-z0-9-]+$`)

// validHeaderValue reports whether a received header can ever equal v. HTTP
// trims the spaces around a field value and a value cannot hold a newline,
// so a value with either (a secret read from a file with a trailing newline,
// for example) would refuse every request while the lock reads as on.
func validHeaderValue(v string) bool {
	return v != "" && strings.TrimSpace(v) == v && !strings.ContainsFunc(v, unicode.IsControl)
}

// validAddr reports whether addr is host:port with a port from 0 to 65535
// and a host that is empty (every interface) or an IP address, so a value
// that would fail at Listen fails validation instead. A host name is
// refused: it may not resolve where the service starts, and only an address
// can be compared with the other listener's (listenersClash).
func validAddr(addr string) bool {
	host, port, ok := splitListen(addr)
	return ok && port >= 0 && port <= 65535 && (host == "" || net.ParseIP(host) != nil)
}

func (c *Config) validatePolling(e *errs) {
	p := c.Polling
	// A timeout at or below zero, or of a few milliseconds, fails every
	// fetch while the file reads as valid.
	if p.RequestTimeout < minRequestTimeout {
		e.addf("polling.request_timeout must be at least %s, got %s", minRequestTimeout, p.RequestTimeout)
	}
	intervals := []struct {
		name string
		d    time.Duration
	}{
		{"components_interval", p.ComponentsInterval},
		{"uptime_interval", p.UptimeInterval},
		{"incidents_interval", p.IncidentsInterval},
	}
	for _, iv := range intervals {
		if iv.d < minInterval {
			e.addf("polling.%s must be at least %s, got %s", iv.name, minInterval, iv.d)
		}
		if p.RequestTimeout >= iv.d {
			e.addf("polling.request_timeout (%s) must be shorter than polling.%s (%s)", p.RequestTimeout, iv.name, iv.d)
		}
	}
	if p.StaleAfter < 2*p.ComponentsInterval {
		e.addf("polling.stale_after (%s) must be at least twice polling.components_interval (%s)", p.StaleAfter, p.ComponentsInterval)
	}
	if p.StaleAfter < 2*p.IncidentsInterval {
		e.addf("polling.stale_after (%s) must be at least twice polling.incidents_interval (%s)", p.StaleAfter, p.IncidentsInterval)
	}
}

func (c *Config) validateBackends(e *errs) {
	if len(c.Backends) == 0 {
		e.addf("backends: at least one backend is required")
	}
	for _, name := range slices.Sorted(maps.Keys(c.Backends)) {
		b := c.Backends[name]
		// A source is keyed "backend/cloud"; with no "/" in the backend
		// name, two sources cannot share a key.
		if !slug.MatchString(name) {
			e.addf("backends: name %q must be a lowercase slug", name)
		}
		if !isHTTPURL(b.BaseURL) {
			e.addf("backends.%s.base_url must be an absolute http(s) URL, got %q", name, b.BaseURL)
		}
		if _, err := b.Location(); err != nil {
			e.addf("backends.%s: %w", name, err)
		}
	}
}

func (c *Config) validateProducts(e *errs) {
	if len(c.Products) == 0 {
		e.addf("products: at least one product is required")
	}
	ids := map[string]bool{}
	for i, p := range c.Products {
		if !slug.MatchString(p.ID) {
			e.addf("products[%d].id %q must be a lowercase slug", i, p.ID)
		}
		if ids[p.ID] {
			e.addf("products[%d].id %q is duplicated", i, p.ID)
		}
		ids[p.ID] = true
		if p.Name == "" {
			e.addf("products[%d] (%s): name is required", i, p.ID)
		}
		if !isHTTPURL(p.PageURL) {
			e.addf("products[%d] (%s): page_url must be an absolute http(s) URL, got %q", i, p.ID, p.PageURL)
		}
		c.validateSources(e, p)
	}
}

func (c *Config) validateSources(e *errs, p Product) {
	if len(p.Sources) == 0 {
		e.addf("product %s: at least one source is required", p.ID)
	}
	seen := map[string]bool{}
	regionIDs := map[string]bool{}
	regionKeys := map[string]map[string]string{}
	for j, s := range p.Sources {
		if _, ok := c.Backends[s.Backend]; !ok {
			e.addf("product %s sources[%d]: unknown backend %q", p.ID, j, s.Backend)
		}
		if s.Cloud == "" {
			e.addf("product %s sources[%d]: cloud is required", p.ID, j)
		}
		if key := s.Backend + "/" + s.Cloud; seen[key] {
			e.addf("product %s sources[%d]: %s is listed twice", p.ID, j, key)
		} else {
			seen[key] = true
		}
		if s.PageURL != "" && !isHTTPURL(s.PageURL) {
			e.addf("product %s sources[%d]: page_url must be an absolute http(s) URL, got %q", p.ID, j, s.PageURL)
		}
		// Without regions, every upstream key would show under a derived id
		// that the API says may change.
		if len(s.Regions) == 0 {
			e.addf("product %s sources[%d]: at least one region is required", p.ID, j)
		}
		validateRegions(e, p.ID, s, c.readsOf(s), regionIDs, regionKeys)
	}
	validateLocations(e, p)
}

// validateLocations checks the product's region locations: every region has
// one or none does, so the page never lists a lone plane beside places; a
// located region's name starts with its location, so the page can show the
// rest ("Data plane") under it; and two location names may not share an id.
func validateLocations(e *errs, p Product) {
	located, unlocated := 0, 0
	names := map[string]string{}
	for _, s := range p.Sources {
		for _, r := range s.Regions {
			if r.Location == "" {
				unlocated++
				continue
			}
			located++
			validateLocation(e, p.ID, r, names)
		}
	}
	if located > 0 && unlocated > 0 {
		e.addf("product %s: every region needs a location, or none may have one", p.ID)
	}
}

// validateLocation checks one located region; names holds, per location id,
// the first location name that took it.
func validateLocation(e *errs, productID string, r RegionRef, names map[string]string) {
	id := r.LocationID()
	if id == "" {
		e.addf("product %s region %s: location %q needs a letter or digit", productID, r.ID, r.Location)
		return
	}
	if rest, found := strings.CutPrefix(r.Name, r.Location+" "); !found || strings.TrimSpace(rest) == "" {
		e.addf("product %s region %s: name %q must be its location %q, a space and more", productID, r.ID, r.Name, r.Location)
	}
	if first, taken := names[id]; taken && first != r.Location {
		e.addf("product %s: locations %q and %q have the same id %q", productID, first, r.Location, id)
	} else {
		names[id] = r.Location
	}
}

// validateRegions checks one source's regions. ids holds the region ids the
// product already uses; keys holds, per cloud the product reads (readsOf),
// the region keys already named and the region that named each. Two regions
// of one product that read the same key would show the same upstream data
// under two names, which a copied region line easily does.
func validateRegions(e *errs, productID string, s SourceRef, reads string, ids map[string]bool, keys map[string]map[string]string) {
	if keys[reads] == nil {
		keys[reads] = map[string]string{}
	}
	for k, r := range s.Regions {
		if r.Key == "" || r.Name == "" {
			e.addf("product %s source %s regions[%d]: key and name are required", productID, s.Cloud, k)
		}
		if !slug.MatchString(r.ID) {
			e.addf("product %s source %s regions[%d]: id %q must be a lowercase slug", productID, s.Cloud, k, r.ID)
		}
		if ids[r.ID] {
			e.addf("product %s: region id %q is duplicated", productID, r.ID)
		}
		ids[r.ID] = true
		if first, taken := keys[reads][r.Key]; taken && r.Key != "" {
			e.addf("product %s source %s regions[%d]: key %q is already read by region %q", productID, s.Cloud, k, r.Key, first)
		} else {
			keys[reads][r.Key] = r.ID
		}
	}
}

// readsOf identifies the data a source reads: two backends of one type and
// base URL serve the same clouds.
func (c *Config) readsOf(s SourceRef) string {
	b, ok := c.Backends[s.Backend]
	if !ok {
		return "\x00" + s.Backend + "\x00" + s.Cloud
	}
	return b.Type + "\x00" + b.BaseURL + "\x00" + s.Cloud
}

func isHTTPURL(raw string) bool {
	u, err := url.Parse(raw)
	return err == nil && (u.Scheme == "https" || u.Scheme == "http") && u.Host != ""
}
