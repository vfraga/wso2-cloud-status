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

# Self-test of the gate scripts CI relies on to fail: scripts/npm-licenses.sh
# and scripts/coverage-gate.sh each get inputs that must pass and inputs that
# must fail, so a gate that always passes is caught.
#
#   scripts/gates-selftest.sh      (or: make gates-selftest)
#
# Needs go and jq.
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
failures=0
cases=0

# expect NAME WANT_EXIT COMMAND...: runs COMMAND and records a failure when its
# exit code differs.
expect() {
  local name="$1" want="$2" got=0
  shift 2
  cases=$((cases + 1))
  "$@" >"$work/out" 2>&1 || got=$?
  if [[ "$got" == "$want" ]]; then
    echo "PASS $name (exit $got)"
  else
    echo "FAIL $name: exit $got, want $want"
    sed 's/^/  /' "$work/out"
    failures=$((failures + 1))
  fi
}

# lockfile LICENCE [DEV] [NAME]: an npm lockfile with one package (x, or
# NAME) under LICENCE, development-only when DEV is true.
lockfile() {
  local path="$work/lock-$cases.json"
  jq -n --arg licence "$1" --argjson dev "${2:-false}" --arg key "node_modules/${3:-x}" \
    '{lockfileVersion: 3, packages: {"": {}, ($key): {version: "1.0.0", license: $licence, dev: $dev}}}' >"$path"
  printf '%s' "$path"
}

expect "licence: one allowed" 0 "$root/scripts/npm-licenses.sh" "$(lockfile MIT)"
expect "licence: allowed alternatives" 0 "$root/scripts/npm-licenses.sh" "$(lockfile "(MIT OR Apache-2.0)")"
expect "licence: allowed together" 0 "$root/scripts/npm-licenses.sh" "$(lockfile "MIT AND ISC")"
expect "licence: copyleft" 1 "$root/scripts/npm-licenses.sh" "$(lockfile GPL-3.0-only)"
expect "licence: allowed and copyleft" 1 "$root/scripts/npm-licenses.sh" "$(lockfile "MIT AND GPL-3.0-only")"
expect "licence: named exception, its licence" 0 "$root/scripts/npm-licenses.sh" "$(lockfile OFL-1.1 false @fontsource-variable/inter)"
expect "licence: named exception, another licence" 1 "$root/scripts/npm-licenses.sh" "$(lockfile GPL-3.0-only false @fontsource-variable/inter)"
expect "licence: alternatives and copyleft" 1 "$root/scripts/npm-licenses.sh" "$(lockfile "(MIT OR Apache-2.0) AND GPL-3.0-only")"
expect "licence: copyleft and alternatives" 1 "$root/scripts/npm-licenses.sh" "$(lockfile "GPL-3.0-only AND (MIT OR Apache-2.0)")"
expect "licence: none declared" 1 "$root/scripts/npm-licenses.sh" "$(lockfile "")"
expect "licence: copyleft, development only" 0 "$root/scripts/npm-licenses.sh" "$(lockfile GPL-3.0-only true)"

# The coverage gate reads the profile with go tool cover, from the module.
cd "$root/backend/go"
go test -count=1 -coverprofile="$work/cover.out" ./internal/domain/ >/dev/null
expect "coverage: above the minimum" 0 "$root/scripts/coverage-gate.sh" "$work/cover.out" 50
expect "coverage: below the minimum" 1 "$root/scripts/coverage-gate.sh" "$work/cover.out" 101

if [[ "$failures" -gt 0 ]]; then
  echo "gates-selftest: $failures of $cases cases failed" >&2
  exit 1
fi
echo "gates-selftest: all $cases cases behaved as expected"
