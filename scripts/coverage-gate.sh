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

# Fails when total statement coverage in a Go cover profile is below a minimum.
# Usage: coverage-gate.sh <coverage.out> <minimum-percent>
set -euo pipefail

profile="${1:?usage: coverage-gate.sh <coverage.out> <minimum-percent>}"
minimum="${2:?usage: coverage-gate.sh <coverage.out> <minimum-percent>}"

total="$(go tool cover -func="$profile" | awk '/^total:/ { sub("%", "", $NF); print $NF }')"
if [[ -z "$total" ]]; then
  echo "coverage-gate: no total in $profile" >&2
  exit 2
fi

echo "### Go coverage"
echo
echo "Total statement coverage: **${total}%** (minimum ${minimum}%)"
if awk -v t="$total" -v m="$minimum" 'BEGIN { exit !(t + 0 < m + 0) }'; then
  echo
  echo "coverage-gate: ${total}% is below the ${minimum}% minimum" >&2
  exit 1
fi
