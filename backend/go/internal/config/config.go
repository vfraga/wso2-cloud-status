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
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"maps"
	"net"
	"os"
	"reflect"
	"regexp"
	"slices"
	"strconv"
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
	AdminAddr       string        `yaml:"admin_addr"`
	CacheControl    string        `yaml:"cache_control"`
	AllowedOrigins  []string      `yaml:"allowed_origins"`
	ShutdownTimeout time.Duration `yaml:"shutdown_timeout"`
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
	// EnvOptions names the options whose value in the file is one ${NAME}
	// reference and nothing else, so an adapter can require a secret to
	// come from the environment. It is set when the file is read.
	EnvOptions map[string]bool `yaml:"-"`
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

// Read reads and defaults the configuration at path without validating it,
// for a caller that changes it (ApplyEnvOverrides) before validating. It
// also returns the SHA-256 of the bytes it read, in hex, which names the
// file in logs.
func Read(path string) (cfg *Config, sha256Hex string, err error) {
	raw, err := os.ReadFile(path) //nolint:gosec // The path comes from the operator, not from a request.
	if err != nil {
		return nil, "", fmt.Errorf("config: read %s: %w", path, err)
	}
	sum := sha256.Sum256(raw)
	cfg, err = decode(raw)
	if err != nil {
		return nil, "", err
	}
	return cfg, hex.EncodeToString(sum[:]), nil
}

// envRef matches ${NAME}; a bare $ is left alone. wholeRef matches a value
// that is one reference and nothing else.
var (
	envRef   = regexp.MustCompile(`\$\{([A-Za-z_][A-Za-z0-9_]*)\}`)
	wholeRef = regexp.MustCompile(`^` + envRef.String() + `$`)
)

// EnvNames are the only environment variables the file may read, by where
// the reference sits: a backend option reads the CSM client's credentials,
// a server.required_headers entry the origin lock's ID. A fixed list, so
// the file cannot send any other variable of the container (a platform
// secret, an identity endpoint) to a host it names.
var EnvNames = map[string][]string{
	"backends.<name>.options.<key>":    {"CSM_CLIENT_ID", "CSM_CLIENT_SECRET"},
	"server.required_headers.<header>": {"FRONT_DOOR_ID"},
}

// expandEnv replaces ${NAME} with the environment value where a reference
// is allowed: as the whole value of a backend option (a credential) or of a
// server.required_headers entry (the origin lock's ID), naming a variable
// EnvNames lists for that place. Anywhere else, as part of a longer value,
// or naming another variable, a reference is an error, as is a YAML alias
// and a second YAML document: otherwise whoever can change the file could
// copy a secret into a value the service sends elsewhere or publishes (a
// base URL, a product's name), or write settings that never apply.
// A backend option that reads the environment makes its backend change only
// on restart (RestartRequired), so a reload never reads a new variable. An
// unset variable is an error, so a missing secret fails at startup, not at
// the first request. Expanded values stay strings.
func expandEnv(raw []byte) ([]byte, error) {
	var doc yaml.Node
	dec := yaml.NewDecoder(bytes.NewReader(raw))
	if err := dec.Decode(&doc); err != nil {
		if errors.Is(err, io.EOF) {
			return raw, nil
		}
		return nil, fmt.Errorf("config: decode: %w", err)
	}
	var next yaml.Node
	if err := dec.Decode(&next); !errors.Is(err, io.EOF) {
		return nil, errors.New("config: the file holds more than one YAML document; settings after a \"---\" line would never apply")
	}
	if len(doc.Content) == 0 {
		return raw, nil
	}
	var e envExpansion
	if err := walkValues(&doc, nil, e.visit); err != nil {
		return nil, err
	}
	if err := e.err(); err != nil {
		return nil, err
	}
	return yaml.Marshal(&doc)
}

// envExpansion expands the references it visits and collects the misplaced
// ones and the unset variables.
type envExpansion struct {
	missing, misplaced []string
}

func (e *envExpansion) visit(n *yaml.Node, path []string) {
	if !envRef.MatchString(n.Value) {
		return
	}
	name := envRef.FindStringSubmatch(n.Value)[1]
	if !wholeRef.MatchString(n.Value) || !slices.Contains(envNamesAt(path), name) {
		e.misplaced = append(e.misplaced, strings.Join(path, "."))
		return
	}
	value, ok := os.LookupEnv(name)
	if !ok {
		e.missing = append(e.missing, name)
	}
	n.Value, n.Tag, n.Style = value, "!!str", yaml.DoubleQuotedStyle
}

func (e *envExpansion) err() error {
	var errs []error
	if len(e.misplaced) > 0 {
		errs = append(errs, fmt.Errorf("config: ${NAME} is allowed only as the whole value of a backend option (%s) or a server.required_headers entry (%s): %v",
			strings.Join(EnvNames["backends.<name>.options.<key>"], ", "), strings.Join(EnvNames["server.required_headers.<header>"], ", "), e.misplaced))
	}
	if len(e.missing) > 0 {
		slices.Sort(e.missing)
		errs = append(errs, fmt.Errorf("config: unset environment variables: %v", slices.Compact(e.missing)))
	}
	return errors.Join(errs...)
}

// envNamesAt is the variables a value at path may read (EnvNames), none
// outside backends.<name>.options.<key> and server.required_headers.<header>.
func envNamesAt(path []string) []string {
	switch {
	case len(path) == 4 && path[0] == "backends" && path[2] == "options":
		return EnvNames["backends.<name>.options.<key>"]
	case len(path) == 3 && path[0] == "server" && path[1] == "required_headers":
		return EnvNames["server.required_headers.<header>"]
	}
	return nil
}

// walkValues visits every scalar that is a value, with its path of mapping
// keys and sequence indices, skipping mapping keys. An alias is an error.
func walkValues(n *yaml.Node, path []string, visit func(*yaml.Node, []string)) error {
	switch n.Kind {
	case yaml.AliasNode:
		return fmt.Errorf("config: YAML aliases are not allowed (at %s)", strings.Join(path, "."))
	case yaml.ScalarNode:
		visit(n, path)
		return nil
	case yaml.DocumentNode, yaml.SequenceNode, yaml.MappingNode:
	}
	nodes, keys := children(n)
	for i, c := range nodes {
		next := path
		if keys[i] != "" {
			next = append(slices.Clone(path), keys[i])
		}
		if err := walkValues(c, next, visit); err != nil {
			return err
		}
	}
	return nil
}

// children lists a node's value children with the path segment each adds: a
// mapping's values under their keys, a sequence's items under their indices,
// a document's root under none.
func children(n *yaml.Node) ([]*yaml.Node, []string) {
	var nodes []*yaml.Node
	var keys []string
	switch n.Kind {
	case yaml.MappingNode:
		for i := 1; i < len(n.Content); i += 2 {
			nodes, keys = append(nodes, n.Content[i]), append(keys, n.Content[i-1].Value)
		}
	case yaml.SequenceNode:
		for i, c := range n.Content {
			nodes, keys = append(nodes, c), append(keys, strconv.Itoa(i))
		}
	default:
		nodes, keys = n.Content, make([]string, len(n.Content))
	}
	return nodes, keys
}

// decode expands ${NAME} references, decodes YAML strictly (unknown keys are
// errors), records which backend options were one reference (EnvOptions)
// and applies defaults.
func decode(raw []byte) (*Config, error) {
	expanded, err := expandEnv(raw)
	if err != nil {
		return nil, err
	}
	var cfg Config
	dec := yaml.NewDecoder(bytes.NewReader(expanded))
	dec.KnownFields(true)
	if err := dec.Decode(&cfg); err != nil {
		return nil, fmt.Errorf("config: decode: %w", err)
	}
	if err := cfg.recordEnvOptions(raw); err != nil {
		return nil, err
	}
	cfg.applyDefaults()
	return &cfg, nil
}

// recordEnvOptions sets each backend's EnvOptions from the file as written,
// before expansion.
func (c *Config) recordEnvOptions(raw []byte) error {
	var written struct {
		Backends map[string]struct {
			Options map[string]string `yaml:"options"`
		} `yaml:"backends"`
	}
	if err := yaml.Unmarshal(raw, &written); err != nil {
		return fmt.Errorf("config: decode: %w", err)
	}
	for name, w := range written.Backends {
		b, ok := c.Backends[name]
		if !ok {
			continue
		}
		for k, v := range w.Options {
			if wholeRef.MatchString(v) {
				if b.EnvOptions == nil {
					b.EnvOptions = map[string]bool{}
				}
				b.EnvOptions[k] = true
			}
		}
		c.Backends[name] = b
	}
	return nil
}

func (c *Config) applyDefaults() {
	setDefault(&c.Server.Addr, ":8080")
	setDefault(&c.Server.AdminAddr, ":9090")
	setDefault(&c.Server.CacheControl, "public, max-age=10, stale-while-revalidate=10, stale-if-error=300")
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
// effect on restart: listeners, the reload loop itself, and every backend
// that reads an option from the environment (a credential) and that next
// adds, changes or removes, named "backends.<name>". The file decides
// where such a backend sends its credential, so a reload must not move it:
// whoever can change the file would otherwise receive the secret.
func (c *Config) RestartRequired(next *Config) []string {
	var changed []string
	if !reflect.DeepEqual(c.Server, next.Server) {
		changed = append(changed, "server")
	}
	if c.Reload.Interval() != next.Reload.Interval() {
		changed = append(changed, "reload")
	}
	names := map[string]bool{}
	for name := range c.Backends {
		names[name] = true
	}
	for name := range next.Backends {
		names[name] = true
	}
	for _, name := range slices.Sorted(maps.Keys(names)) {
		running, ran := c.Backends[name]
		proposed, proposes := next.Backends[name]
		if !running.credentialed() && !proposed.credentialed() {
			continue
		}
		if ran != proposes || !reflect.DeepEqual(running, proposed) {
			changed = append(changed, "backends."+name)
		}
	}
	return changed
}

// credentialed reports whether the backend reads any option from the
// environment.
func (b Backend) credentialed() bool {
	return slices.Contains(slices.Collect(maps.Values(b.EnvOptions)), true)
}

// ApplyEnvOverrides applies the settings the platform passes in the
// environment: PORT, which platforms such as Cloud Run set, replaces the
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
