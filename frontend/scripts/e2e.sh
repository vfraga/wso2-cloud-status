#!/usr/bin/env bash
# Copyright (c) 2026, WSO2 LLC. (https://www.wso2.com).
#
# WSO2 LLC. licenses this file to you under the Apache License,
# Version 2.0 (the "License"); you may not use this file except
# in compliance with the License.
# You may obtain a copy of the License at
#
#     http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing,
# software distributed under the License is distributed on an
# "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
# KIND, either express or implied. See the License for the
# specific language governing permissions and limitations
# under the License.

# Runs the Playwright suite against the real Go backend fed by a fixture upstream.
#
#   scripts/e2e.sh [playwright args...]
#   E2E_SCENARIOS="ok stale" scripts/e2e.sh
#
# Builds statusd and the fixture upstream into a temporary directory, builds the
# site, serves it with `vite preview` (which proxies /api to statusd), and runs
# one spec file per scenario against a freshly started backend. E2E_SCENARIOS
# picks the scenarios (default: ok degraded stale outdated stopped
# stopped@Asia/Colombo); "name@Zone" runs that spec with the browser in that
# time zone instead of UTC. Ports 18190 to 18193 by default; the script stops
# when one is already in use, since a process left there would answer in place
# of this run's servers. Screenshots go to SHOT_DIR (default
# test-results/shots), a zone's under a subdirectory. E2E_FIXTURE_DIR tells a
# spec where the running upstream reads its files, so it can remove one mid-run.
set -euo pipefail

frontend="$(cd "$(dirname "$0")/.." && pwd)"
root="$(cd "$frontend/.." && pwd)"
upstream_port="${E2E_UPSTREAM_PORT:-18190}"
api_port="${E2E_API_PORT:-18191}"
admin_port="${E2E_ADMIN_PORT:-18192}"
web_port="${E2E_WEB_PORT:-18193}"
work="$(mktemp -d)"
pids=()
export SHOT_DIR="${SHOT_DIR:-$frontend/test-results/shots}"
mkdir -p "$SHOT_DIR"

stop_backend() {
  local pid
  for pid in "${pids[@]:-}"; do
    [[ -n "$pid" ]] && { kill "$pid" 2>/dev/null; wait "$pid" 2>/dev/null; } || true
  done
  pids=()
}
# shellcheck disable=SC2329 # called by the EXIT trap
cleanup() {
  stop_backend
  [[ -n "${web_pid:-}" ]] && { kill "$web_pid" 2>/dev/null; wait "$web_pid" 2>/dev/null; } || true
  rm -rf "$work"
}
trap cleanup EXIT

# wait_for <url> <pid>: until the url answers, as long as that process runs.
wait_for() {
  local url="$1" pid="$2" _
  for _ in $(seq 1 150); do
    kill -0 "$pid" 2>/dev/null || return 1
    curl -fsS "$url" >/dev/null 2>&1 && return 0
    sleep 0.2
  done
  return 1
}

# Stops when a port already accepts connections.
require_free() {
  local port
  for port in "$@"; do
    if (exec 3<>"/dev/tcp/127.0.0.1/${port}") 2>/dev/null; then
      echo "e2e: port ${port} is already in use; stop that process first" >&2
      exit 1
    fi
  done
}

# The outdated and stopped scenarios need the staleness budgets to run out
# within seconds: 5 s polls and stale_after 10s give each kind of data a budget
# of max(10s, 3 x 5s) = 15 s. stale-if-error follows stale_after down, as
# statusd requires.
render_config() {
  if [[ "$1" == outdated || "$1" == stopped ]]; then
    sed -E \
      -e "s#^  components_interval: .*#  components_interval: 5s#" \
      -e "s#^  incidents_interval: .*#  incidents_interval: 5s#" \
      -e "s#^  uptime_interval: .*#  uptime_interval: 5s#" \
      -e "s#^  request_timeout: .*#  request_timeout: 2s#" \
      -e "s#^  stale_after: .*#  stale_after: 10s#" \
      -e "s#stale-if-error=[0-9]+#stale-if-error=10#" \
      "$work/statusd.base.yaml" >"$work/statusd.yaml"
  else
    cp "$work/statusd.base.yaml" "$work/statusd.yaml"
  fi
}

start_backend() {
  local scenario="$1"
  require_free "$upstream_port" "$api_port" "$admin_port"
  render_config "$scenario"
  node "$frontend/e2e/build-fixtures.mjs" "$scenario" "$work/fixtures"
  "$work/upstream" -addr "127.0.0.1:${upstream_port}" -dir "$work/fixtures" >"$work/upstream.log" 2>&1 &
  pids+=("$!")
  wait_for "http://127.0.0.1:${upstream_port}/api/v1/monitors?cloud=bijira" "$!" || { echo "e2e: upstream did not start" >&2; cat "$work/upstream.log" >&2; exit 1; }
  STATUSD_CONFIG="$work/statusd.yaml" "$work/statusd" >"$work/statusd.log" 2>&1 &
  pids+=("$!")
  wait_for "http://127.0.0.1:${api_port}/readyz" "$!" || { echo "e2e: statusd never became ready" >&2; cat "$work/statusd.log" >&2; exit 1; }
}

require_free "$upstream_port" "$api_port" "$admin_port" "$web_port"

(cd "$root/backend/go" && CGO_ENABLED=0 go build -trimpath -o "$work/statusd" ./cmd/statusd)
(cd "$root/tests/contract" && go build -o "$work/upstream" ./cmd/upstream)
sed -E \
  -e "s#base_url: .*#base_url: http://127.0.0.1:${upstream_port}#" \
  -e "s#^  addr: .*#  addr: \"127.0.0.1:${api_port}\"#" \
  -e "s#^  admin_addr: .*#  admin_addr: \"127.0.0.1:${admin_port}\"#" \
  "$root/config/statusd.yaml" >"$work/statusd.base.yaml"

cd "$frontend"
npm run build --silent
# The vite binary itself, not npx, so the recorded pid is the server cleanup stops.
API_PROXY_TARGET="http://127.0.0.1:${api_port}" ./node_modules/.bin/vite preview --host 127.0.0.1 --port "$web_port" --strictPort >"$work/web.log" 2>&1 &
web_pid=$!
wait_for "http://127.0.0.1:${web_port}/" "$web_pid" || { echo "e2e: preview did not start" >&2; cat "$work/web.log" >&2; exit 1; }

export E2E_BASE_URL="http://127.0.0.1:${web_port}"
export E2E_FIXTURE_DIR="$work/fixtures"
read -r -a scenarios <<<"${E2E_SCENARIOS:-ok degraded stale outdated stopped stopped@Asia/Colombo}"
shots="$SHOT_DIR"
status=0
for entry in "${scenarios[@]}"; do
  scenario="${entry%%@*}"
  zone=UTC
  [[ "$entry" == *@* ]] && zone="${entry#*@}"
  echo "== scenario: $scenario (time zone $zone)"
  shot_dir="$shots"
  [[ "$zone" == UTC ]] || shot_dir="$shots/${zone//\//-}"
  mkdir -p "$shot_dir"
  start_backend "$scenario"
  E2E_TZ="$zone" SHOT_DIR="$shot_dir" npx playwright test "e2e/specs/${scenario}.spec.ts" "$@" || status=1
  stop_backend
done
exit "$status"
