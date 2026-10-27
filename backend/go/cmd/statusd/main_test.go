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

package main

import (
	"bufio"
	"bytes"
	"errors"
	"fmt"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
	"time"

	"github.com/wso2/wso2-cloud-status/backend/go/internal/config"
)

const (
	shippedConfig    = "../../../../config/statusd.yaml"
	productionConfig = "../../../../config/statusd.production.yaml"
)

// check runs statusd with args and returns the exit code and both outputs.
func check(t *testing.T, args ...string) (int, string, string) {
	t.Helper()
	var stdout, stderr bytes.Buffer
	code := run(args, &stdout, &stderr)
	return code, stdout.String(), stderr.String()
}

// A minimal valid configuration: one backend, then one product.
const (
	backend = "backends:\n  b: { base_url: \"https://example.test\" }\n"
	product = `
products:
  - id: p
    name: P
    sources: [{ backend: b, cloud: c, regions: [{ key: us, id: us, name: US }] }]
`
)

// writeConfig writes a configuration file and returns its path.
func writeConfig(t *testing.T, body string) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "statusd.yaml")
	if err := os.WriteFile(path, []byte(body), 0o600); err != nil {
		t.Fatal(err)
	}
	return path
}

// TestCheckConfigShippedFiles: both shipped files pass, and the output says
// whether the origin lock is on without printing the Front Door id.
func TestCheckConfigShippedFiles(t *testing.T) {
	t.Setenv("FRONT_DOOR_ID", "fdid-placeholder")
	t.Setenv("PORT", "")
	cfg, err := config.Load(shippedConfig)
	if err != nil {
		t.Fatal(err)
	}
	n := len(cfg.Products)
	for path, want := range map[string]string{
		shippedConfig:    fmt.Sprintf("is valid: %d products, origin lock off\n", n),
		productionConfig: fmt.Sprintf("is valid: %d products, origin lock on [X-Azure-FDID]\n", n),
	} {
		code, stdout, stderr := check(t, "-check-config", path)
		if code != 0 || !strings.HasSuffix(stdout, want) || stderr != "" {
			t.Errorf("%s: exit %d, stdout %q, stderr %q; want 0 and %q", path, code, stdout, stderr, want)
		}
		if strings.Contains(stdout, "fdid-placeholder") {
			t.Errorf("%s: the output must not carry the Front Door id: %q", path, stdout)
		}
	}
}

// TestCheckConfigRejects: everything a start would reject fails the check
// with exit 1 and the reason on stderr: an unset ${NAME}, a validation
// error, a missing file, an adapter that refuses its backend's settings, and
// a PORT that collides with the admin port.
func TestCheckConfigRejects(t *testing.T) {
	t.Setenv("PORT", "")
	if err := os.Unsetenv("PORT"); err != nil {
		t.Fatal(err)
	}
	t.Setenv("FRONT_DOOR_ID", "")
	if err := os.Unsetenv("FRONT_DOOR_ID"); err != nil {
		t.Fatal(err)
	}
	for name, tc := range map[string]struct {
		path string
		want string
	}{
		"unset variable": {productionConfig, "unset environment variables: [FRONT_DOOR_ID]"},
		"validation":     {writeConfig(t, backend+product+"history: { days: 400 }\n"), "history.days must be between 1 and 366"},
		"missing file":   {filepath.Join(t.TempDir(), "absent.yaml"), "no such file"},
		"adapter": {
			writeConfig(t, "backends:\n  b: { base_url: \"https://example.test\", options: { token: x } }\n"+product),
			"legacyapi: unknown options [token]",
		},
	} {
		code, stdout, stderr := check(t, "-check-config", tc.path)
		if code != 1 || stdout != "" || !strings.Contains(stderr, tc.path+" is invalid: ") || !strings.Contains(stderr, tc.want) {
			t.Errorf("%s: exit %d, stdout %q, stderr %q; want 1 and %q", name, code, stdout, stderr, tc.want)
		}
	}

	code, _, stderr := check(t, "-check-config", writeConfig(t, everyProblem))
	for _, want := range everyProblemNamed {
		if code != 1 || !strings.Contains(stderr, want) {
			t.Errorf("every problem: exit %d, stderr %q; want 1 and %q", code, stderr, want)
		}
	}

	t.Setenv("PORT", "9090")
	if code, _, stderr := check(t, "-check-config", writeConfig(t, backend+product)); code != 1 || !strings.Contains(stderr, "must differ") {
		t.Errorf("PORT on the admin port: exit %d, stderr %q; want 1 and the collision named", code, stderr)
	}
}

// everyProblem has a validation error and two backends their adapters
// refuse; a check and a start name all three (everyProblemNamed).
const everyProblem = `
history: { days: 400 }
backends:
  a: { type: legacy-status-apo, base_url: "https://a.example.test" }
  b: { base_url: "https://b.example.test", options: { tokn: x } }
products:
  - id: p
    name: P
    sources:
      - { backend: a, cloud: c, regions: [{ key: us, id: us, name: US }] }
      - { backend: b, cloud: c, regions: [{ key: eu, id: eu, name: EU }] }
`

var everyProblemNamed = []string{"history.days must be between 1 and 366", "legacy-status-apo", "unknown options [tokn]"}

// TestCheckConfigBindsNothing: the check passes for a file whose ports are
// taken, because it never listens; a start with it would fail.
func TestCheckConfigBindsNothing(t *testing.T) {
	t.Setenv("PORT", "")
	ln, err := (&net.ListenConfig{}).Listen(t.Context(), "tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = ln.Close() })
	path := writeConfig(t, backend+product+"server: { addr: \""+ln.Addr().String()+"\", admin_addr: \"127.0.0.1:0\" }\n")
	if code, stdout, stderr := check(t, "-check-config", path); code != 0 {
		t.Fatalf("exit %d, stdout %q, stderr %q; want 0 with the public port taken", code, stdout, stderr)
	}
}

func TestCommandLine(t *testing.T) {
	for name, tc := range map[string]struct {
		args []string
		code int
		out  string
	}{
		"version":         {[]string{"-version"}, 0, "dev\n"},
		"help":            {[]string{"-h"}, 0, ""},
		"unknown flag":    {[]string{"-nope"}, 2, ""},
		"missing a value": {[]string{"-check-config"}, 2, ""},
	} {
		if code, stdout, _ := check(t, tc.args...); code != tc.code || stdout != tc.out {
			t.Errorf("%s: exit %d, stdout %q; want %d and %q", name, code, stdout, tc.code, tc.out)
		}
	}
}

// TestHelperProcess is not a test of its own: TestServeLifecycle runs the
// test binary with STATUSD_HELPER=1 so that statusd's run function serves in
// a child process, as the real binary does, signals included.
func TestHelperProcess(t *testing.T) {
	if os.Getenv("STATUSD_HELPER") != "1" {
		t.Skip("run by TestServeLifecycle")
	}
	args := os.Args
	for i, a := range args {
		if a == "--" {
			args = args[i+1:]
			break
		}
	}
	os.Exit(run(args, os.Stdout, os.Stderr))
}

// statusd starts statusd in a child process with args and returns it with
// its log lines, one per value received.
func statusd(t *testing.T, args ...string) (*exec.Cmd, <-chan string) {
	t.Helper()
	cmd := exec.CommandContext(t.Context(), os.Args[0], append([]string{"-test.run=^TestHelperProcess$", "--"}, args...)...)
	cmd.Env = append(os.Environ(), "STATUSD_HELPER=1", "PORT=")
	out, err := cmd.StdoutPipe()
	if err != nil {
		t.Fatal(err)
	}
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	lines := make(chan string, 64)
	go func() {
		scanner := bufio.NewScanner(out)
		for scanner.Scan() {
			lines <- scanner.Text()
		}
		close(lines)
	}()
	return cmd, lines
}

// await returns the first log line that holds every part, or fails.
func await(t *testing.T, lines <-chan string, parts ...string) string {
	t.Helper()
	deadline := time.After(10 * time.Second)
	for {
		select {
		case line, ok := <-lines:
			if !ok {
				t.Fatalf("statusd exited before logging %q", parts)
			}
			if all(line, parts) {
				return line
			}
		case <-deadline:
			t.Fatalf("statusd did not log %q in time", parts)
		}
	}
}

func all(line string, parts []string) bool {
	for _, p := range parts {
		if !strings.Contains(line, p) {
			return false
		}
	}
	return true
}

// TestServeLifecycle runs statusd as a process: SIGHUP reloads the
// configuration file and statusd keeps serving, SIGTERM shuts it down with
// exit 0, and a configuration rejected at startup, whether by validation or
// by a backend's adapter, exits 2 and logs "configuration rejected" with
// every problem. Operators read the exit code and that message.
func TestServeLifecycle(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		bodies := map[string]string{
			"/api/v1/monitors":       `{"us":[{"display_name":"G","subgroups":[{"display_name":"C","status":0}]}]}`,
			"/api/v1/availabilities": `{"us":[{"availability":"100.000","duration":"Last 7 days"}]}`,
			"/api/v1/incidents":      `{"2026-10":{"incidents":[]}}`,
		}
		_, _ = w.Write([]byte(bodies[r.URL.Path]))
	}))
	t.Cleanup(upstream.Close)
	config := func(name string) string {
		return fmt.Sprintf(`
server: { addr: "127.0.0.1:0", admin_addr: "127.0.0.1:0" }
reload: { watch_interval: 0s }
backends:
  b: { base_url: %q }
products:
  - id: p
    name: %s
    sources: [{ backend: b, cloud: c, regions: [{ key: us, id: us, name: US }] }]
`, upstream.URL, name)
	}
	path := writeConfig(t, config("Before"))
	cmd, lines := statusd(t, "-config", path)
	await(t, lines, `"msg":"serving"`)

	if err := os.WriteFile(path, []byte(config("After")), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := cmd.Process.Signal(syscall.SIGHUP); err != nil {
		t.Fatal(err)
	}
	await(t, lines, `"msg":"configuration reloaded"`, `"trigger":"signal"`)

	if err := cmd.Process.Signal(syscall.SIGTERM); err != nil {
		t.Fatal(err)
	}
	await(t, lines, `"msg":"shutting down"`)
	if err := cmd.Wait(); err != nil {
		t.Fatalf("after SIGTERM: %v, want exit 0", err)
	}

	for name, body := range map[string]string{
		"validation":           backend + product + "history: { days: 400 }\n",
		"unknown backend type": strings.Replace(backend, "base_url", "type: csm, base_url", 1) + product,
		"every problem":        everyProblem,
	} {
		bad, badLines := statusd(t, "-config", writeConfig(t, body))
		parts := []string{`"level":"ERROR"`, `"msg":"configuration rejected"`}
		if name == "every problem" {
			parts = append(parts, everyProblemNamed...)
		}
		await(t, badLines, parts...)
		var exit *exec.ExitError
		if err := bad.Wait(); !errors.As(err, &exit) || exit.ExitCode() != 2 {
			t.Errorf("%s: %v, want exit 2", name, err)
		}
	}
}
