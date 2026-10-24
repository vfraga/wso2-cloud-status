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

# Captures upstream fixtures for the contract and end-to-end tests from the
# real public status APIs: testdata/upstream/<cloud>.monitors.json,
# <cloud>.availabilities.json and <cloud>.incidents.json.
#
#   scripts/capture-fixtures.sh              every cloud in config/statusd.yaml
#   scripts/capture-fixtures.sh <cloud>...   only those clouds (a new product)
#
# The clouds, and the base URL each is read from, are the sources of the
# products in config/statusd.yaml and the base_url of their backends.
#
# Each cloud's three files are replaced only when all three answered. The
# tests expect what the committed files hold: every product operational,
# with the region counts in TestFixtureExpectations, and in choreo the two
# entries CSM holds for one event on 17 Aug 2026, which
# checkCollapsedIncidents expects to see merged. So capture only the clouds
# you need, while their products are operational, and run make contract
# afterwards; restore a file with git checkout when a test needs what it
# held.
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
out="$root/testdata/upstream"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

# One line per source: its cloud and its backend's base URL.
sources="$(awk '
  /^[^ #]/ { section = $1 }
  { gsub(/"/, "") }
  section == "backends:" && /^  [a-z0-9_-]+:/ { name = $1; sub(/:$/, "", name) }
  section == "backends:" && /^    base_url:/ { url[name] = $2 }
  section == "products:" && /^ *- backend:/ { backend = $3 }
  section == "products:" && /^ *cloud:/ { print $2, url[backend] }
' "$root/config/statusd.yaml")"
if [[ -z "$sources" ]]; then
  echo "capture-fixtures: found no product sources in config/statusd.yaml" >&2
  exit 2
fi
all=()
while read -r cloud base; do
  if [[ ! "$base" =~ ^https?:// ]]; then
    echo "capture-fixtures: no base URL for cloud '$cloud' in config/statusd.yaml" >&2
    exit 2
  fi
  all+=("$cloud")
done <<<"$sources"

capture() {
  local cloud="$1" base endpoint
  base="$(awk -v c="$cloud" '$1 == c { print $2; exit }' <<<"$sources")"
  if [[ -z "$base" ]]; then
    echo "capture-fixtures: config/statusd.yaml has no source with cloud '$cloud'" >&2
    exit 2
  fi
  for endpoint in monitors availabilities incidents; do
    curl -fsS --max-time 15 "$base/api/v1/$endpoint?cloud=$cloud" -o "$work/$cloud.$endpoint.json"
  done
  mv "$work/$cloud".*.json "$out/"
  echo "captured $cloud into $out"
}

if [[ $# -eq 0 ]]; then
  set -- "${all[@]}"
fi
for cloud in "$@"; do
  [[ "$cloud" =~ ^[a-z0-9-]+$ ]] || {
    echo "capture-fixtures: '$cloud' is not a cloud key" >&2
    exit 2
  }
  capture "$cloud"
done
