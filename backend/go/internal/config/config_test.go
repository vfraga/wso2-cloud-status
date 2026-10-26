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
	"bytes"
	"maps"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"

	"go.yaml.in/yaml/v3"
)

const (
	repoConfig       = "../../../../config/statusd.yaml"
	productionConfig = "../../../../config/statusd.production.yaml"
)

// TestShippedConfigIsValid: the catalogue loads; its ids and order are
// checked against the page's own list in frontend/src/lib/fallbackProducts.test.ts.
func TestShippedConfigIsValid(t *testing.T) {
	t.Parallel()
	cfg, err := Load(repoConfig)
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if len(cfg.Products) == 0 {
		t.Fatal("the shipped configuration lists no products")
	}
}

// TestProductionConfig: the production file turns the origin lock on with
// the Front Door id from the environment, refuses to load without it, and
// differs from config/statusd.yaml in nothing else, so the catalogue cannot
// drift between the two. Both poll components and incidents every 30 s and
// uptime every 5 min, the cadence the page is specified with.
func TestProductionConfig(t *testing.T) {
	t.Setenv("FRONT_DOOR_ID", "00000000-0000-0000-0000-000000000001")
	prod, err := Load(productionConfig)
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if want := map[string]string{"X-Azure-FDID": "00000000-0000-0000-0000-000000000001"}; !maps.Equal(prod.Server.RequiredHeaders, want) {
		t.Fatalf("required_headers = %v, want %v", prod.Server.RequiredHeaders, want)
	}
	shipped, err := Load(repoConfig)
	if err != nil {
		t.Fatal(err)
	}
	if len(shipped.Server.RequiredHeaders) != 0 {
		t.Fatalf("config/statusd.yaml must keep the origin lock off for local runs, has %v", shipped.Server.RequiredHeaders)
	}
	for name, cfg := range map[string]*Config{repoConfig: shipped, productionConfig: prod} {
		p := cfg.Polling
		if p.ComponentsInterval != 30*time.Second || p.IncidentsInterval != 30*time.Second || p.UptimeInterval != 5*time.Minute {
			t.Errorf("%s polls components every %s, incidents every %s and uptime every %s; want 30s, 30s and 5m",
				name, p.ComponentsInterval, p.IncidentsInterval, p.UptimeInterval)
		}
	}
	prod.Server.RequiredHeaders = nil
	if !reflect.DeepEqual(prod, shipped) {
		t.Fatalf("config/statusd.production.yaml differs from config/statusd.yaml in more than the origin lock:\nproduction %+v\nshipped    %+v", prod, shipped)
	}

	if err := os.Unsetenv("FRONT_DOOR_ID"); err != nil {
		t.Fatal(err)
	}
	if _, err := Load(productionConfig); err == nil || !strings.Contains(err.Error(), "FRONT_DOOR_ID") {
		t.Fatalf("without FRONT_DOOR_ID: err = %v, want the variable named", err)
	}
}

const minimal = `
backends:
  b: { base_url: "https://example.test" }
products:
  - id: p
    name: P
    page_url: https://p.example.test
    sources:
      - backend: b
        cloud: c
        regions: [{ key: us, id: us, name: US }]
`

func TestDefaults(t *testing.T) {
	t.Parallel()
	cfg, err := Parse([]byte(minimal))
	if err != nil {
		t.Fatalf("Parse: %v", err)
	}
	if cfg.Server.Addr != ":8080" || cfg.Server.AdminAddr != ":9090" || cfg.Polling.ComponentsInterval != 30*time.Second ||
		cfg.Polling.StaleAfter != 5*time.Minute || cfg.History.Days != 90 ||
		cfg.Backends["b"].Timezone != "UTC" || len(cfg.Server.AllowedOrigins) != 1 {
		t.Fatalf("defaults not applied: %+v", cfg)
	}
	loc, err := cfg.Backends["b"].Location()
	if err != nil || loc != time.UTC {
		t.Fatalf("Location = %v, %v", loc, err)
	}
}

// TestShippedCacheControlIsTheDefault: a configuration without
// server.cache_control caches like the shipped one (Validate holds the
// limits; TestValuesThatCannotWorkAreRejected tests them).
func TestShippedCacheControlIsTheDefault(t *testing.T) {
	t.Parallel()
	shipped, err := Load(repoConfig)
	if err != nil {
		t.Fatal(err)
	}
	defaults, err := Parse([]byte(minimal))
	if err != nil {
		t.Fatal(err)
	}
	if defaults.Server.CacheControl != shipped.Server.CacheControl {
		t.Fatalf("default cache_control %q, shipped %q; want equal", defaults.Server.CacheControl, shipped.Server.CacheControl)
	}
}

func TestNewDefaults(t *testing.T) {
	t.Parallel()
	cfg, err := Parse([]byte(minimal))
	if err != nil {
		t.Fatal(err)
	}
	if cfg.Server.MaxInFlight != 1024 || cfg.Server.NotFoundCacheControl != "public, max-age=60" ||
		cfg.Reload.Interval() != 10*time.Second || cfg.Backends["b"].Type != "legacy-status-api" {
		t.Fatalf("defaults: %+v %+v %v", cfg.Server, cfg.Backends["b"], cfg.Reload.Interval())
	}
	off, err := Parse([]byte(minimal + "reload: { watch_interval: 0s }\n"))
	if err != nil || off.Reload.Interval() != 0 {
		t.Fatalf("explicit 0s must disable watching: %v %v", err, off)
	}
}

func TestEnvironmentReferences(t *testing.T) {
	t.Setenv("STATUSD_TEST_FDID", "abc-123")
	cfg, err := Parse([]byte(minimal + "server: { required_headers: { X-Azure-FDID: \"${STATUSD_TEST_FDID}\" } }\n"))
	if err != nil {
		t.Fatal(err)
	}
	if cfg.Server.RequiredHeaders["X-Azure-FDID"] != "abc-123" {
		t.Fatalf("required headers = %v", cfg.Server.RequiredHeaders)
	}
	_, err = Parse([]byte(minimal + "server: { required_headers: { A: \"${STATUSD_TEST_UNSET_1}\", B: \"${STATUSD_TEST_UNSET_1}\" } }\n"))
	if err == nil || !strings.Contains(err.Error(), "[STATUSD_TEST_UNSET_1]") {
		t.Fatalf("err = %v, want the unset variable named once", err)
	}
	if _, err := Parse([]byte(minimal + "# costs $5, not a reference\n")); err != nil {
		t.Fatalf("a bare $ must be left alone: %v", err)
	}
	if _, err := Parse([]byte(minimal + "# example: \"${STATUSD_TEST_UNSET_2}\"\n")); err != nil {
		t.Fatalf("references in comments must not be expanded: %v", err)
	}
	if _, err := Parse([]byte("")); err == nil {
		t.Fatal("an empty file must fail validation")
	}
	if _, err := Parse([]byte("products: [\n")); err == nil {
		t.Fatal("malformed YAML must fail")
	}
}

// TestEnvironmentReferencesAreTyped: an unquoted reference reads as the
// type of its value, so it can set an integer or a boolean field; a quoted
// one, or one that would read as null, stays a string.
func TestEnvironmentReferencesAreTyped(t *testing.T) {
	t.Setenv("STATUSD_TEST_DAYS", "30")
	t.Setenv("STATUSD_TEST_FLIGHT", "512")
	t.Setenv("STATUSD_TEST_FLAG", "true")
	t.Setenv("STATUSD_TEST_ID", "12345")
	t.Setenv("STATUSD_TEST_NULL", "null")
	t.Setenv("STATUSD_TEST_EMPTY", "")
	cfg, err := Parse([]byte(minimal + `history:
  days: ${STATUSD_TEST_DAYS}
server:
  max_in_flight: ${STATUSD_TEST_FLIGHT}
  required_headers:
    A: ${STATUSD_TEST_ID}
    B: "${STATUSD_TEST_ID}"
    C: ${STATUSD_TEST_NULL}
    D: ${STATUSD_TEST_EMPTY}x
`))
	if err != nil {
		t.Fatal(err)
	}
	if cfg.History.Days != 30 || cfg.Server.MaxInFlight != 512 {
		t.Fatalf("days %d, max_in_flight %d; want 30 and 512 from the environment", cfg.History.Days, cfg.Server.MaxInFlight)
	}
	want := map[string]string{"A": "12345", "B": "12345", "C": "null", "D": "x"}
	if !maps.Equal(cfg.Server.RequiredHeaders, want) {
		t.Fatalf("required headers = %v, want %v", cfg.Server.RequiredHeaders, want)
	}

	// The configuration has no boolean field yet; decode the expansion
	// into one the way Parse decodes the configuration.
	raw, err := expandEnv([]byte("on: ${STATUSD_TEST_FLAG}\nquoted: \"${STATUSD_TEST_FLAG}\"\n"))
	if err != nil {
		t.Fatal(err)
	}
	var flags struct {
		On     bool   `yaml:"on"`
		Quoted string `yaml:"quoted"`
	}
	dec := yaml.NewDecoder(bytes.NewReader(raw))
	dec.KnownFields(true)
	if err := dec.Decode(&flags); err != nil || !flags.On || flags.Quoted != "true" {
		t.Fatalf("flags = %+v, err %v; want the bool true and the string \"true\"", flags, err)
	}
}

func TestEphemeralPortsMayRepeat(t *testing.T) {
	t.Parallel()
	if _, err := Parse([]byte(minimal + "server: { addr: \"127.0.0.1:0\", admin_addr: \"127.0.0.1:0\" }\n")); err != nil {
		t.Fatalf("port 0 on both listeners is valid (the OS picks distinct ports): %v", err)
	}
}

func TestRestartRequired(t *testing.T) {
	t.Parallel()
	a, _ := Parse([]byte(minimal))
	b, _ := Parse([]byte(minimal + "history: { days: 30 }\n"))
	if got := a.RestartRequired(b); len(got) != 0 {
		t.Fatalf("history change flagged as restart-required: %v", got)
	}
	c, _ := Parse([]byte(minimal + "server: { addr: \":9999\" }\nreload: { watch_interval: 1m }\n"))
	if got := a.RestartRequired(c); len(got) != 2 {
		t.Fatalf("RestartRequired = %v, want server and reload", got)
	}
}

func TestApplyEnvOverrides(t *testing.T) {
	t.Parallel()
	env := func(port string) func(string) string {
		return func(name string) string {
			if name == "PORT" {
				return port
			}
			return ""
		}
	}
	cfg, _ := Parse([]byte(minimal))
	if cfg.ApplyEnvOverrides(env("")); cfg.Server.Addr != ":8080" {
		t.Fatalf("no PORT: addr %q", cfg.Server.Addr)
	}
	if cfg.ApplyEnvOverrides(env("8123")); cfg.Server.Addr != ":8123" || cfg.Validate() != nil {
		t.Fatalf("PORT=8123: addr %q, err %v", cfg.Server.Addr, cfg.Validate())
	}
	// Applied to every load, the override never reads as a restart-only change.
	again, _ := Parse([]byte(minimal))
	if again.ApplyEnvOverrides(env("8123")); len(cfg.RestartRequired(again)) != 0 {
		t.Fatalf("reloaded with the same PORT: %v", cfg.RestartRequired(again))
	}
	clash, _ := Parse([]byte(minimal))
	if clash.ApplyEnvOverrides(env("9090")); clash.Validate() == nil || !strings.Contains(clash.Validate().Error(), "must differ") {
		t.Fatalf("PORT on the admin port: err = %v", clash.Validate())
	}
}

func TestUnknownKeysAreRejected(t *testing.T) {
	t.Parallel()
	_, err := Parse([]byte(minimal + "\nhistroy: { days: 30 }\n"))
	if err == nil || !strings.Contains(err.Error(), "histroy") {
		t.Fatalf("err = %v, want the misspelled key named", err)
	}
}

func TestEveryProblemIsReported(t *testing.T) {
	t.Parallel()
	bad := `
server: { addr: ":7000", admin_addr: ":7000", max_in_flight: -1, required_headers: { "Bad Header": "x", Empty: "" } }
reload: { watch_interval: 10ms }
polling: { components_interval: 1s, request_timeout: 10m, stale_after: 1s }
history: { days: 400 }
backends:
  b: { base_url: "ftp://x", timezone: "Mars/Olympus" }
products:
  - id: Bad_ID
    page_url: nope
    sources:
      - backend: missing
        page_url: "::"
        regions: [{ key: "", id: "Not Slug", name: "" }, { key: k, id: dup, name: n }, { key: k2, id: dup, name: n2 }]
      - backend: missing
  - id: Bad_ID
    name: Second
    page_url: https://ok.test
`
	_, err := Parse([]byte(bad))
	if err == nil {
		t.Fatal("expected validation errors")
	}
	for _, want := range []string{
		"must differ",
		"max_in_flight",
		"\"Bad Header\" needs a valid header name",
		"\"Empty\" needs a valid header name",
		"reload.watch_interval",
		"components_interval must be at least",
		"request_timeout (10m0s) must be shorter than polling.uptime_interval",
		"must be at least twice polling.components_interval",
		"must be at least twice polling.incidents_interval",
		"history.days",
		"backends.b.base_url",
		"Mars/Olympus",
		"must be a lowercase slug",
		"is duplicated",
		"name is required",
		"page_url must be an absolute",
		"unknown backend",
		"cloud is required",
		"is listed twice",
		"key and name are required",
		"region id \"dup\" is duplicated",
		"at least one source is required",
	} {
		if !strings.Contains(err.Error(), want) {
			t.Errorf("error does not mention %q:\n%v", want, err)
		}
	}
}

// TestValuesThatCannotWorkAreRejected: values that pass a type check but
// fail once the service runs are rejected when the file is read. A required
// header value with surrounding spaces or a control character (a secret read
// from a file with a trailing newline) can never match a received header; a
// port outside 0 to 65535 fails at Listen; a listen host name may not
// resolve, and only IP addresses can be compared (one address spelt two
// ways is one address); a source without regions shows
// every upstream key under ids that may change; history.days runs from 1
// to 366.
func TestValuesThatCannotWorkAreRejected(t *testing.T) {
	t.Parallel()
	for name, tc := range map[string]struct {
		yaml, want string
	}{
		"header value with a trailing newline": {`server: { required_headers: { X-Azure-FDID: "abc\n" } }`, "X-Azure-FDID"},
		"header value with a leading space":    {`server: { required_headers: { X-Azure-FDID: " abc" } }`, "X-Azure-FDID"},
		"header value of spaces only":          {`server: { required_headers: { X-Azure-FDID: "   " } }`, "X-Azure-FDID"},
		"header value with a tab":              {`server: { required_headers: { X-Azure-FDID: "a\tb" } }`, "X-Azure-FDID"},
		"port out of range":                    {`server: { addr: ":80800" }`, "server.addr must be host:port"},
		"port not a number":                    {`server: { admin_addr: ":abc" }`, "server.admin_addr must be host:port"},
		"no port":                              {`server: { addr: "8080" }`, "server.addr must be host:port"},
		"history longer than a year":           {`history: { days: 367 }`, "history.days must be between 1 and 366"},
		"CDN copy held for a whole poll":       {`server: { cache_control: "public, max-age=10, stale-while-revalidate=20" }`, "under 30s"},
		"no max-age":                           {`server: { cache_control: "public, stale-if-error=60" }`, "max-age must be above 0"},
		"error copy older than stale_after":    {`server: { cache_control: "public, max-age=10, stale-if-error=301" }`, "stale-if-error must be at most"},
		"directive value not a number":         {`server: { cache_control: "public, max-age=ten" }`, "max-age must be a number"},
		"a CDN lifetime the rules do not read": {`server: { cache_control: "public, max-age=10, s-maxage=600" }`, `"s-maxage=600" is not public`},
		"a directive given twice":              {`server: { cache_control: "public, max-age=600, max-age=10" }`, "max-age is given twice"},
		"not-found copy with s-maxage":         {`server: { not_found_cache_control: "public, s-maxage=86400" }`, "server.not_found_cache_control"},
		"listeners on one port":                {`server: { addr: ":18803", admin_addr: "127.0.0.1:18803" }`, "must differ"},
		"one address, two spellings":           {`server: { addr: "[::ffff:127.0.0.1]:18803", admin_addr: "127.0.0.1:18803" }`, "must differ"},
		"a host name":                          {`server: { addr: "localhost:18803", admin_addr: "127.0.0.1:18804" }`, `server.addr must be host:port with an IP address or no host`},
		"a host name that does not resolve":    {`server: { admin_addr: "no-such-host.invalid:18803" }`, `server.admin_addr must be host:port with an IP address or no host`},
		"a source without regions": {
			strings.Replace(minimal, "        regions: [{ key: us, id: us, name: US }]\n", "", 1),
			"at least one region is required",
		},
	} {
		body := tc.yaml
		if !strings.Contains(body, "products:") {
			body = minimal + body + "\n"
		}
		if _, err := Parse([]byte(body)); err == nil || !strings.Contains(err.Error(), tc.want) {
			t.Errorf("%s: err = %v, want it to name %q", name, err, tc.want)
		}
	}
	for _, addr := range []string{":0", "127.0.0.1:18800", "[::1]:9091", "0.0.0.0:65535"} {
		if _, err := Parse([]byte(minimal + "server: { addr: \"" + addr + "\" }\n")); err != nil {
			t.Errorf("addr %q: %v", addr, err)
		}
	}
	for _, pair := range []string{`addr: "127.0.0.1:18803", admin_addr: "127.0.0.2:18803"`, `addr: ":0", admin_addr: ":0"`} {
		if _, err := Parse([]byte(minimal + "server: { " + pair + " }\n")); err != nil {
			t.Errorf("%s: %v", pair, err)
		}
	}
	cfg, err := Parse([]byte(minimal))
	if err != nil {
		t.Fatal(err)
	}
	cfg.ApplyEnvOverrides(func(string) string { return "80800" })
	if err := cfg.Validate(); err == nil || !strings.Contains(err.Error(), "server.addr") {
		t.Fatalf("PORT=80800: err = %v, want server.addr named", err)
	}
}

// TestSourceKeysCannotCollide: a source is keyed "backend/cloud", so a "/"
// in a backend name could give two sources one key, and one would show the
// other's data. Backend names are slugs.
func TestSourceKeysCannotCollide(t *testing.T) {
	t.Parallel()
	_, err := Parse([]byte(`
backends:
  "a/x": { base_url: "https://one.test" }
  a: { base_url: "https://two.test" }
products:
  - id: p1
    name: P1
    page_url: https://p1.test
    sources: [{ backend: "a/x", cloud: y, regions: [{ key: us, id: us, name: US }] }]
  - id: p2
    name: P2
    page_url: https://p2.test
    sources: [{ backend: a, cloud: "x/y", regions: [{ key: us, id: us, name: US }] }]
`))
	if err == nil || !strings.Contains(err.Error(), `backends: name "a/x" must be a lowercase slug`) {
		t.Fatalf("err = %v, want the backend name a/x refused", err)
	}
}

// TestRegionKeysAreUniquePerCloud: within one product, two regions may not
// read the same upstream key of the same cloud, whether in one source or
// through two backends with the same type and base URL. Different clouds,
// and different products, may use the same key.
func TestRegionKeysAreUniquePerCloud(t *testing.T) {
	t.Parallel()
	const backends = `
backends:
  b: { base_url: "https://example.test" }
  alias: { base_url: "https://example.test" }
  other: { base_url: "https://other.test" }
`
	tests := []struct {
		name, products, want string
	}{
		{"copied line in one source", `
  - id: p
    name: P
    page_url: https://p.test
    sources:
      - backend: b
        cloud: c
        regions: [{ key: "cp - us", id: us, name: US }, { key: "cp - us", id: eu, name: EU }]
`, `product p source c regions[1]: key "cp - us" is already read by region "us"`},
		{"same cloud through two backends", `
  - id: p
    name: P
    page_url: https://p.test
    sources:
      - { backend: b, cloud: c, regions: [{ key: us, id: us, name: US }] }
      - { backend: alias, cloud: c, regions: [{ key: us, id: us-2, name: US 2 }] }
`, `product p source c regions[0]: key "us" is already read by region "us"`},
		{"different clouds and products", `
  - id: p
    name: P
    page_url: https://p.test
    sources:
      - { backend: b, cloud: c, regions: [{ key: us, id: us, name: US }] }
      - { backend: b, cloud: d, regions: [{ key: us, id: us-d, name: US D }] }
      - { backend: other, cloud: c, regions: [{ key: us, id: us-o, name: US O }] }
  - id: q
    name: Q
    page_url: https://q.test
    sources:
      - { backend: b, cloud: c, regions: [{ key: us, id: us, name: US }] }
`, ""},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			_, err := Parse([]byte(backends + "products:" + tt.products))
			if tt.want == "" && err != nil {
				t.Fatalf("err = %v, want none", err)
			}
			if tt.want != "" && (err == nil || !strings.Contains(err.Error(), tt.want)) {
				t.Fatalf("err = %v, want it to contain %s", err, tt.want)
			}
		})
	}
}

func TestSlugify(t *testing.T) {
	t.Parallel()
	for in, want := range map[string]string{"cp - us": "cp-us", "EU - DP - EU": "eu-dp-eu", "  x  ": "x", "US": "us", "--": ""} {
		if got := Slugify(in); got != want {
			t.Fatalf("Slugify(%q) = %q, want %q", in, got, want)
		}
	}
}

// TestRegionLocations: every region of a product has a location or none
// does; a located region's name is its location, a space and more; two
// location names of one product may not share an id. Products are checked
// one by one, so two products may differ.
func TestRegionLocations(t *testing.T) {
	t.Parallel()
	const head = `
backends:
  b: { base_url: "https://example.test" }
products:
  - id: p
    name: P
    page_url: https://p.test
    sources:
      - backend: b
        cloud: c
        regions:
`
	tests := []struct {
		name, regions, want string
	}{
		{"located", `
          - { key: a, id: us-cp, name: US control plane, location: US }
          - { key: b, id: eu-dp, name: EU data plane (US-managed), location: EU }
`, ""},
		{"none located", `
          - { key: a, id: us, name: US }
          - { key: b, id: eu, name: EU }
`, ""},
		{"one without", `
          - { key: a, id: us-cp, name: US control plane, location: US }
          - { key: b, id: eu, name: EU }
`, "product p: every region needs a location, or none may have one"},
		{"name without the location", `
          - { key: a, id: us-cp, name: Control plane, location: US }
`, `name "Control plane" must be its location "US", a space and more`},
		{"name that is only the location", `
          - { key: a, id: us-cp, name: "US ", location: US }
`, `name "US " must be its location "US"`},
		{"location without a letter", `
          - { key: a, id: x, name: "- x", location: "-" }
`, `location "-" needs a letter or digit`},
		{"two names, one id", `
          - { key: a, id: us-cp, name: US control plane, location: US }
          - { key: b, id: us-dp, name: us data plane, location: us }
`, `locations "US" and "us" have the same id "us"`},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			_, err := Parse([]byte(head + tt.regions))
			if tt.want == "" && err != nil {
				t.Fatalf("err = %v, want none", err)
			}
			if tt.want != "" && (err == nil || !strings.Contains(err.Error(), tt.want)) {
				t.Fatalf("err = %v, want it to contain %s", err, tt.want)
			}
		})
	}
}

// TestTimeoutBounds: a request timeout at or below zero, or of a few
// milliseconds, would fail every fetch while the file reads as valid; a
// shutdown timeout below a second cuts requests in flight at every deploy,
// and one above a minute only delays deploys.
func TestTimeoutBounds(t *testing.T) {
	t.Parallel()
	tests := []struct {
		set, want string
	}{
		{"polling: { request_timeout: -5s }", "polling.request_timeout must be at least 100ms, got -5s"},
		{"polling: { request_timeout: 5ms }", "polling.request_timeout must be at least 100ms, got 5ms"},
		{"polling: { request_timeout: 100ms }", ""},
		{"server: { shutdown_timeout: -1s }", "server.shutdown_timeout must be between 1s and 1m0s, got -1s"},
		{"server: { shutdown_timeout: 10ms }", "server.shutdown_timeout must be between 1s and 1m0s, got 10ms"},
		{"server: { shutdown_timeout: 2m }", "server.shutdown_timeout must be between 1s and 1m0s, got 2m0s"},
		{"server: { shutdown_timeout: 1m }", ""},
	}
	for _, tt := range tests {
		_, err := Parse([]byte(minimal + tt.set + "\n"))
		if tt.want == "" && err != nil {
			t.Errorf("%s: err = %v, want none", tt.set, err)
		}
		if tt.want != "" && (err == nil || !strings.Contains(err.Error(), tt.want)) {
			t.Errorf("%s: err = %v, want it to contain %q", tt.set, err, tt.want)
		}
	}
}

func TestEmptyConfigNeedsBackendsAndProducts(t *testing.T) {
	t.Parallel()
	_, err := Parse([]byte("server: { addr: ':9000' }\n"))
	if err == nil || !strings.Contains(err.Error(), "at least one backend") || !strings.Contains(err.Error(), "at least one product") {
		t.Fatalf("err = %v", err)
	}
}

func TestLoadErrors(t *testing.T) {
	t.Parallel()
	if _, err := Load(filepath.Join(t.TempDir(), "missing.yaml")); err == nil {
		t.Fatal("expected an error for a missing file")
	}
	path := filepath.Join(t.TempDir(), "bad.yaml")
	if err := os.WriteFile(path, []byte("products: [\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := Load(path); err == nil {
		t.Fatal("expected a decode error")
	}
}
