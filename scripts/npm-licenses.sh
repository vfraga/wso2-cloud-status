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

# Licence allow-list for the npm packages the frontend ships.
#
#   scripts/npm-licenses.sh [LOCKFILE]   (or: make web-licenses)
#
# Reads LOCKFILE (default frontend/package-lock.json, lockfile version 2 or
# 3) and checks every package that is not development-only (npm marks those
# "dev": true; optional and devOptional packages count as shipped). Each
# must declare a licence on the shipped-code allow-list of
# docs/dependency-policy.md, or be a named exception below with exactly that
# licence. An SPDX expression passes when it is one allowed licence,
# alternatives joined by OR of which one is allowed, or licences joined by AND
# that are all allowed, with or without parentheses around the whole. An
# expression that mixes AND and OR, a WITH clause or "SEE LICENSE IN" needs a
# named exception. A package without a licence fails.
#
# It needs no GitHub feature, unlike the dependency review, so it also runs
# on a private repository without GitHub Code Security. Development-only
# packages are left to the dependency review and to review by hand.
#
# Prints each package that fails, and exits 0 when none does, 1 when one
# does, 2 on a usage error. Needs jq.
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
lock="${1:-$root/frontend/package-lock.json}"

allowed='["Apache-2.0", "MIT", "MIT-0", "BSD-2-Clause", "BSD-3-Clause", "ISC", "CC0-1.0", "BlueOak-1.0.0"]'
# Named exceptions: package name and the one licence it may carry.
exceptions='{"@fontsource-variable/inter": "OFL-1.1"}'

command -v jq >/dev/null 2>&1 || {
  echo "npm-licenses: jq is required" >&2
  exit 2
}
[[ -r "$lock" ]] || {
  echo "npm-licenses: cannot read $lock" >&2
  exit 2
}
jq -e '(.lockfileVersion // 0) >= 2 and (.packages | type == "object")' "$lock" >/dev/null 2>&1 || {
  echo "npm-licenses: $lock is not an npm lockfile of version 2 or later" >&2
  exit 2
}

# One line per shipped package: "ok" or "fail", then name@version and licence.
report="$(jq -r --argjson allowed "$allowed" --argjson exceptions "$exceptions" '
  def name: sub("^.*node_modules/"; "");
  def allowed_expression:
    gsub("^\\(|\\)$"; "") as $e
    | if ($e | test("[()]")) or (($e | test(" OR ")) and ($e | test(" AND "))) then false
      elif ($e | test(" OR ")) then $e | split(" OR ") | any(IN($allowed[]))
      else $e | split(" AND ") | all(IN($allowed[])) end;
  .packages | to_entries[]
  | select(.key != "" and .value.dev != true and .value.link != true)
  | (.key | name) as $name
  | (.value.license | if type == "string" then . else "" end) as $licence
  | (if $licence == "" then "fail"
     elif ($licence | allowed_expression) or $exceptions[$name] == $licence then "ok"
     else "fail" end) as $verdict
  | "\($verdict) \($name)@\(.value.version // "?") \(if $licence == "" then "(no licence declared)" else $licence end)"
' "$lock")"

total="$(grep -c '' <<<"$report" || true)"
failed="$(grep '^fail ' <<<"$report" || true)"
if [[ -n "$failed" ]]; then
  echo "npm-licenses: shipped packages outside the allow-list (docs/dependency-policy.md):" >&2
  awk '{ sub(/^fail /, "  "); print }' <<<"$failed" >&2
  echo "npm-licenses: $(grep -c '' <<<"$failed") of $total shipped packages fail" >&2
  exit 1
fi
echo "npm-licenses: all $total shipped packages in $(basename "$lock") are on the allow-list or named exceptions"
