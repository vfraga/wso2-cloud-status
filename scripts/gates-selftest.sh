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

# Self-test of the gates CI relies on to fail: scripts/npm-licenses.sh,
# scripts/coverage-gate.sh and the Makefile's workflow-cache and pins each get
# inputs that must pass and inputs that must fail, so a gate that always
# passes is caught.
#
#   scripts/gates-selftest.sh      (or: make gates-selftest)
#
# Needs go, jq and make.
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

# workflow-cache and pins run in a directory holding only the workflows given.
cd "$root"
# workflows NAME: a directory for one case, its workflow read from stdin.
workflows() {
  mkdir -p "$work/$1/.github/workflows"
  cat >"$work/$1/.github/workflows/w.yml"
  printf '%s' "$work/$1"
}
# gate DIR TARGET: the Makefile's TARGET run in DIR, exit 1 when it fails.
gate() {
  make -s -C "$1" -f "$root/Makefile" "$2" 2>/dev/null || return 1
}
# shellcheck disable=SC2016 # a workflow's own expression, not the shell's
privileged_job='jobs:
  build:
    runs-on: ubuntu-24.04
    env:
      TOKEN: ${{ secrets.TOKEN }}
    steps:'
expect "workflow-cache: a job with secrets, its caches off" 0 gate "$(workflows off <<YAML
$privileged_job
      - uses: actions/checkout@v6
      - uses: actions/setup-go@v6
        with:
          cache: false
YAML
)" workflow-cache
expect "workflow-cache: a job without secrets, a cache on" 0 gate "$(workflows plain <<'YAML'
jobs:
  build:
    runs-on: ubuntu-24.04
    steps:
      - uses: actions/setup-go@v6
YAML
)" workflow-cache
expect "workflow-cache: a job with secrets, a cache on" 1 gate "$(workflows on <<YAML
$privileged_job
      - uses: actions/setup-go@v6
YAML
)" workflow-cache
expect "workflow-cache: an action the check does not know" 1 gate "$(workflows unknown <<YAML
$privileged_job
      - uses: actions/setup-python@v6
        with:
          cache: pip
YAML
)" workflow-cache
expect "workflow-cache: id-token for the whole workflow" 1 gate "$(workflows wide-token <<'YAML'
permissions:
  id-token: write
jobs:
  build:
    runs-on: ubuntu-24.04
    steps:
      - uses: actions/setup-go@v6
YAML
)" workflow-cache
expect "workflow-cache: a secret in the whole workflow's env" 1 gate "$(workflows wide-secret <<'YAML'
env:
  TOKEN: ${{ secrets.TOKEN }}
jobs:
  build:
    runs-on: ubuntu-24.04
    steps:
      - uses: actions/setup-go@v6
YAML
)" workflow-cache
mkdir -p "$work/pins/.github/workflows" "$work/drift/.github/workflows"
cp .github/workflows/ci.yml .github/workflows/release.yml "$work/pins/.github/workflows/"
expect "pins: the workflows as they are" 0 gate "$work/pins" pins
cp .github/workflows/release.yml "$work/drift/.github/workflows/"
sed -E 's/(hadolint-action@[0-9a-f]+ # )v[0-9.]+$/\1v0.0.1/' .github/workflows/ci.yml >"$work/drift/.github/workflows/ci.yml"
expect "pins: ci.yml moved to another hadolint-action" 1 gate "$work/drift" pins

if [[ "$failures" -gt 0 ]]; then
  echo "gates-selftest: $failures of $cases cases failed" >&2
  exit 1
fi
echo "gates-selftest: all $cases cases behaved as expected"
