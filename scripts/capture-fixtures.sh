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
#   scripts/capture-fixtures.sh              every cloud below
#   scripts/capture-fixtures.sh <cloud>...   only those clouds (a new product)
#
# The cloud asgardeo is read from api.status.asgardeo.io, every other one
# from api.status.cloudservices.wso2.com. Keep the list below in step with
# the clouds in config/statusd.yaml.
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

out="$(cd "$(dirname "$0")/.." && pwd)/testdata/upstream"
cloudservices="https://api.status.cloudservices.wso2.com"
asgardeo="https://api.status.asgardeo.io"
all=(agent-manager bijira choreo choreo-eu devant moesif asgardeo)
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

capture() {
  local cloud="$1" base="$cloudservices" endpoint
  [[ "$cloud" == asgardeo ]] && base="$asgardeo"
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
