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

// Package config loads and validates the service configuration: server
// settings, polling cadence, upstream backends and the product catalog.
package config

import (
	"bytes"
	"errors"
	"fmt"
	"net"
	"os"
	"reflect"
	"regexp"
	"slices"
	"strings"
	"time"

	"go.yaml.in/yaml/v3"
)

// Config is the whole service configuration.
type Config struct {
	Server   Server             `yaml:"server"`
	Reload   Reload             `yaml:"reload"`
	Polling  Polling            `yaml:"polling"`
	History  History            `yaml:"history"`
	Backends map[string]Backend `yaml:"backends"`
	Products []Product          `yaml:"products"`
}

// Server holds HTTP listener and response settings.
type Server struct {
	Addr string `yaml:"addr"`
	// AdminAddr serves /metrics and probes; keep it off the public ingress.
	AdminAddr    string `yaml:"admin_addr"`
	CacheControl string `yaml:"cache_control"`
	// NotFoundCacheControl lets the CDN absorb floods of random paths.
	NotFoundCacheControl string        `yaml:"not_found_cache_control"`
	AllowedOrigins       []string      `yaml:"allowed_origins"`
	ShutdownTimeout      time.Duration `yaml:"shutdown_timeout"`
	// MaxInFlight sheds load with 503 once this many requests are in
	// progress, protecting the origin if the CDN is bypassed.
	MaxInFlight int `yaml:"max_in_flight"`
	// RequiredHeaders locks the public listener to the CDN: requests
	// without these exact headers get 403 (probes are exempt). Values
	// usually come from the environment, e.g. "${FRONT_DOOR_ID}".
	RequiredHeaders map[string]string `yaml:"required_headers"`
}

// Reload controls picking up configuration changes without a restart.
type Reload struct {
	// WatchInterval is how often the file is checked for changes; 0
	// disables watching. SIGHUP always reloads. Defaults to 10s.
	WatchInterval *time.Duration `yaml:"watch_interval"`
}

// Interval returns the effective watch interval.
func (r Reload) Interval() time.Duration {
	if r.WatchInterval == nil {
		return 10 * time.Second
	}
	return *r.WatchInterval
}

// Polling holds how often each kind of upstream data is fetched, and when
// data is too old to show.
type Polling struct {
	ComponentsInterval time.Duration `yaml:"components_interval"`
	UptimeInterval     time.Duration `yaml:"uptime_interval"`
	IncidentsInterval  time.Duration `yaml:"incidents_interval"`
	RequestTimeout     time.Duration `yaml:"request_timeout"`
	StaleAfter         time.Duration `yaml:"stale_after"`
}

// History holds the daily history strip settings.
type History struct {
	Days int `yaml:"days"`
}

// Backend is one upstream status data source.
type Backend struct {
	// Type selects the adapter, e.g. "legacy-status-api". New data sources
	// (CSM) register a new type; nothing else changes.
	Type    string `yaml:"type"`
	BaseURL string `yaml:"base_url"`
	// Timezone the backend's zone-less timestamps are written in.
	Timezone string `yaml:"timezone"`
	// Options are adapter-specific settings; each adapter rejects keys it
	// does not know. Secrets belong in the environment: "${NAME}".
	Options map[string]string `yaml:"options"`
}

// Product is one row on the status page.
type Product struct {
	ID          string      `yaml:"id"`
	Name        string      `yaml:"name"`
	Description string      `yaml:"description"`
	Sources     []SourceRef `yaml:"sources"`
}

// SourceRef binds a product to one cloud on one backend.
type SourceRef struct {
	Backend string      `yaml:"backend"`
	Cloud   string      `yaml:"cloud"`
	Regions []RegionRef `yaml:"regions"`
}

// RegionRef names and orders an upstream region key.
type RegionRef struct {
	Key  string `yaml:"key"`
	ID   string `yaml:"id"`
	Name string `yaml:"name"`
	// Location groups the parts of one place, such as the US control and
	// data planes; the name then starts with it ("US control plane").
	Location string `yaml:"location"`
}

// LocationID is the slug of the region's location, empty when it has none.
func (r RegionRef) LocationID() string {
	return Slugify(r.Location)
}

// Slugify lowercases s and joins its runs of letters and digits with "-".
func Slugify(s string) string {
	fields := strings.FieldsFunc(strings.ToLower(s), func(r rune) bool {
		return (r < 'a' || r > 'z') && (r < '0' || r > '9')
	})
	return strings.Join(fields, "-")
}

// Load reads, defaults and validates the configuration at path.
func Load(path string) (*Config, error) {
	cfg, err := Read(path)
	if err != nil {
		return nil, err
	}
	if err := cfg.Validate(); err != nil {
		return nil, err
	}
	return cfg, nil
}

// Read reads and defaults the configuration at path without validating it,
// for a caller that changes it (ApplyEnvOverrides) before validating.
func Read(path string) (*Config, error) {
	raw, err := os.ReadFile(path) //nolint:gosec // The path comes from the operator, not from a request.
	if err != nil {
		return nil, fmt.Errorf("config: read %s: %w", path, err)
	}
	return decode(raw)
}

// envRef matches ${NAME}; a bare $ is left alone.
var envRef = regexp.MustCompile(`\$\{([A-Za-z_][A-Za-z0-9_]*)\}`)

// expandEnv replaces ${NAME} in YAML values (never in comments or keys) with
// the environment value. An unset variable is an error, so a missing secret
// fails at startup, not at the first request.
//
// An unquoted value that held a reference loses its string tag, so the
// result is typed by its new text: "max_in_flight: ${N}" with N=512 is the
// integer 512, as if 512 had been written there. A quoted value stays a
// string, and so does a result that would read as null (empty, "~", "null").
func expandEnv(raw []byte) ([]byte, error) {
	var doc yaml.Node
	if err := yaml.Unmarshal(raw, &doc); err != nil {
		return nil, fmt.Errorf("config: decode: %w", err)
	}
	if len(doc.Content) == 0 {
		return raw, nil
	}
	var missing []string
	walkValues(&doc, func(n *yaml.Node) {
		found := false
		n.Value = envRef.ReplaceAllStringFunc(n.Value, func(ref string) string {
			found = true
			name := envRef.FindStringSubmatch(ref)[1]
			value, ok := os.LookupEnv(name)
			if !ok {
				missing = append(missing, name)
			}
			return value
		})
		if found && n.Style&quoted == 0 && !nullish[n.Value] {
			n.Tag = ""
		}
	})
	if len(missing) > 0 {
		slices.Sort(missing)
		return nil, fmt.Errorf("config: unset environment variables: %v", slices.Compact(missing))
	}
	return yaml.Marshal(&doc)
}

// quoted styles keep a scalar a string whatever its text.
const quoted = yaml.SingleQuotedStyle | yaml.DoubleQuotedStyle | yaml.LiteralStyle | yaml.FoldedStyle

// nullish are the plain scalars YAML reads as null.
var nullish = map[string]bool{"": true, "~": true, "null": true, "Null": true, "NULL": true}

// walkValues visits every scalar that is a value, skipping mapping keys.
func walkValues(n *yaml.Node, visit func(*yaml.Node)) {
	switch n.Kind {
	case yaml.ScalarNode:
		visit(n)
	case yaml.MappingNode:
		for i := 1; i < len(n.Content); i += 2 {
			walkValues(n.Content[i], visit)
		}
	default:
		for _, c := range n.Content {
			walkValues(c, visit)
		}
	}
}

// Parse decodes raw (decode) and validates it. Every validation problem is
// reported, not only the first.
func Parse(raw []byte) (*Config, error) {
	cfg, err := decode(raw)
	if err != nil {
		return nil, err
	}
	if err := cfg.Validate(); err != nil {
		return nil, err
	}
	return cfg, nil
}

// decode expands ${NAME} references, decodes YAML strictly (unknown keys are
// errors) and applies defaults.
func decode(raw []byte) (*Config, error) {
	raw, err := expandEnv(raw)
	if err != nil {
		return nil, err
	}
	var cfg Config
	dec := yaml.NewDecoder(bytes.NewReader(raw))
	dec.KnownFields(true)
	if err := dec.Decode(&cfg); err != nil {
		return nil, fmt.Errorf("config: decode: %w", err)
	}
	cfg.applyDefaults()
	return &cfg, nil
}

func (c *Config) applyDefaults() {
	setDefault(&c.Server.Addr, ":8080")
	setDefault(&c.Server.AdminAddr, ":9090")
	setDefault(&c.Server.CacheControl, "public, max-age=10, stale-while-revalidate=10, stale-if-error=300")
	setDefault(&c.Server.NotFoundCacheControl, "public, max-age=60")
	setDefault(&c.Server.MaxInFlight, 1024)
	if c.Server.AllowedOrigins == nil {
		c.Server.AllowedOrigins = []string{"*"}
	}
	setDefault(&c.Server.ShutdownTimeout, 10*time.Second)
	setDefault(&c.Polling.ComponentsInterval, 30*time.Second)
	setDefault(&c.Polling.UptimeInterval, 5*time.Minute)
	setDefault(&c.Polling.IncidentsInterval, 30*time.Second)
	setDefault(&c.Polling.RequestTimeout, 5*time.Second)
	setDefault(&c.Polling.StaleAfter, 5*time.Minute)
	setDefault(&c.History.Days, 90)
	for name, b := range c.Backends {
		setDefault(&b.Type, "legacy-status-api")
		setDefault(&b.Timezone, "UTC")
		c.Backends[name] = b
	}
}

// RestartRequired lists the settings that differ from next but only take
// effect on restart: listeners and the reload loop itself.
func (c *Config) RestartRequired(next *Config) []string {
	var changed []string
	if !reflect.DeepEqual(c.Server, next.Server) {
		changed = append(changed, "server")
	}
	if c.Reload.Interval() != next.Reload.Interval() {
		changed = append(changed, "reload")
	}
	return changed
}

// ApplyEnvOverrides applies the settings the platform passes in the
// environment: PORT (Azure App Service, Cloud Run, Choreo) replaces the
// public listener's port. Validate afterwards: the new address may collide
// with the admin address. The service applies it at startup and on every
// reload, so a reload never mistakes the override for a change that needs a
// restart.
func (c *Config) ApplyEnvOverrides(getenv func(string) string) {
	if port := getenv("PORT"); port != "" {
		c.Server.Addr = net.JoinHostPort("", port)
	}
}

func setDefault[T comparable](field *T, value T) {
	var zero T
	if *field == zero {
		*field = value
	}
}

// Location returns the backend's configured time zone.
func (b Backend) Location() (*time.Location, error) {
	loc, err := time.LoadLocation(b.Timezone)
	if err != nil {
		return nil, fmt.Errorf("config: timezone %q: %w", b.Timezone, err)
	}
	return loc, nil
}

// errs collects validation problems.
type errs []error

func (e *errs) addf(format string, args ...any) {
	*e = append(*e, fmt.Errorf(format, args...))
}

func (e errs) join() error {
	if len(e) == 0 {
		return nil
	}
	return fmt.Errorf("config: invalid:\n%w", errors.Join(e...))
}
