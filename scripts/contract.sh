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

# Runs the contract tests against any backend implementation.
#
#   scripts/contract.sh <command that starts the backend>
#   CONTRACT_SCENARIO=edge scripts/contract.sh <command>
#   CONTRACT_SOURCE=csm scripts/contract.sh <command>
#
# Starts a fixture upstream, writes a configuration pointing at it, starts the
# backend with STATUSD_CONFIG set, waits for readiness, runs tests/contract,
# then stops everything. Ports are overridable via environment variables.
#
# The upstream replays testdata/upstream. CONTRACT_SCENARIO=<name> copies
# testdata/contract-<name> over those files first; the "edge" scenario holds
# upstream data the captured fixtures do not (null and missing statuses, an
# unrecognised incident type, colliding region keys, an empty incidents
# response, outage, maintenance and degraded components, a region key the
# configuration does not name, an active Maintenance incident, and a second
# source of a two-source product that answers {} for components and
# incidents), and the tests it enables check how the backend reads it.
#
# CONTRACT_SOURCE=csm points every backend at the upstream's CSM side
# instead (cloud-status reads in ServiceNow's envelope, behind a client
# credentials token), so the same tests check the CSM adapter.
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
upstream_port="${UPSTREAM_PORT:-18090}"
api_port="${API_PORT:-18091}"
admin_port="${ADMIN_PORT:-18092}"
scenario="${CONTRACT_SCENARIO:-}"
source_type="${CONTRACT_SOURCE:-legacy}"
work="$(mktemp -d)"
pids=()

cleanup() {
  for pid in "${pids[@]:-}"; do
    [[ -n "$pid" ]] && { kill "$pid" 2>/dev/null; wait "$pid" 2>/dev/null; } || true
  done
  rm -rf "$work"
}

wait_for() {
  local url="$1"
  for _ in $(seq 1 150); do
    curl -fsS "$url" >/dev/null 2>&1 && return 0
    sleep 0.2
  done
  return 1
}
trap cleanup EXIT

fixtures="$root/testdata/upstream"
if [[ -n "$scenario" ]]; then
  if [[ ! -d "$root/testdata/contract-$scenario" ]]; then
    echo "contract: no testdata/contract-$scenario for CONTRACT_SCENARIO=$scenario" >&2
    exit 2
  fi
  fixtures="$work/fixtures"
  mkdir "$fixtures"
  # The scenario's files replace captured ones of the same name. Two calls:
  # GNU cp refuses to write one target twice in a single call.
  cp "$root"/testdata/upstream/*.json "$fixtures/"
  cp "$root/testdata/contract-$scenario"/*.json "$fixtures/"
fi

case "$source_type" in
  legacy | csm) ;;
  *) echo "contract: CONTRACT_SOURCE must be legacy or csm, not $source_type" >&2; exit 2 ;;
esac
# A throwaway secret the fake token endpoint and statusd both read from the
# environment, as statusd reads the real one.
CSM_CLIENT_SECRET="$(od -An -N16 -tx1 /dev/urandom | tr -d ' \n')"
export CSM_CLIENT_SECRET

(cd "$root/tests/contract" && go build -o "$work/upstream" ./cmd/upstream)
"$work/upstream" -addr "127.0.0.1:${upstream_port}" -dir "$fixtures" >"$work/upstream.log" 2>&1 &
pids+=("$!")
wait_for "http://127.0.0.1:${upstream_port}/api/v1/monitors?cloud=moesif" || { echo "contract: upstream did not start" >&2; exit 1; }

sed -E \
  -e "s#base_url: .*#base_url: http://127.0.0.1:${upstream_port}#" \
  -e "s#^  addr: .*#  addr: \"127.0.0.1:${api_port}\"#" \
  -e "s#^  admin_addr: .*#  admin_addr: \"127.0.0.1:${admin_port}\"#" \
  "$root/config/statusd.yaml" >"$work/statusd.yaml"
if [[ "$source_type" == csm ]]; then
  awk -v token="http://127.0.0.1:${upstream_port}/oauth2/token" '
    /^    type: legacy-status-api$/ {
      print "    type: csm-cloud-status"
      print "    options: {token_url: \"" token "\", client_id: contract, client_secret: \"${CSM_CLIENT_SECRET}\"}"
      next
    }
    { print }' "$work/statusd.yaml" >"$work/statusd.csm.yaml"
  grep -q "csm-cloud-status" "$work/statusd.csm.yaml" || { echo "contract: no backend switched to CSM" >&2; exit 1; }
  mv "$work/statusd.csm.yaml" "$work/statusd.yaml"
fi

export STATUSD_CONFIG="$work/statusd.yaml"
"$@" >"$work/backend.log" 2>&1 &
pids+=("$!")

if ! wait_for "http://127.0.0.1:${api_port}/readyz"; then
  echo "contract: backend never became ready; log follows" >&2
  cat "$work/backend.log" >&2
  exit 1
fi

# The captured-fixture expectations hold only without a scenario.
captured=1
[[ -n "$scenario" ]] && captured=0
cd "$root/tests/contract"
BASE_URL="http://127.0.0.1:${api_port}" CONTRACT_FIXTURES="$captured" CONTRACT_SCENARIO="$scenario" go test -count=1 -v ./... |
  grep -E '^(=== RUN|--- |PASS|FAIL|ok|\s+\S+_test.go)' || { echo "contract: FAILED" >&2; exit 1; }
