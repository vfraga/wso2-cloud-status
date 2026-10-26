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

# Self-test of scripts/ops/synthetic-check.sh against a local statusd.
#
#   scripts/ops/synthetic-selftest.sh      (or: make synthetic-selftest)
#
# Builds statusd and the fixture upstream, starts them with a configuration
# rendered as scripts/contract.sh does, serves a page shaped like the built
# frontend (a module script, a module preload and a stylesheet under
# /assets), and expects the check to:
#   1. pass with everything up;
#   2. fail on freshness when the summary's generated_at is older than the
#      limit (MAX_AGE_SECONDS=1 once it is at least 2 seconds old);
#   3. fail on freshness and incidents with the default limit (300 s, the
#      page's own) when an old copy of the API is 7 to 8 minutes old;
#   4. pass, with an INFO line naming the product, when one upstream source
#      has never answered (one dead source is not a status page failure);
#   5. fail on data when most products have no known status, although
#      statusd answers and is fresh: with the backend that serves five of the
#      six products dead, and with every source dead;
#   6. fail with 403 when the origin lock of config/statusd.production.yaml
#      is on and the caller does not send the Front Door header (what a wrong
#      FRONT_DOOR_ID looks like);
#   7. fail on assets when the page references a script the server does not
#      have (the blank page after a half-finished deploy);
#   8. fail on assets when a script or a stylesheet answers 200 with HTML (an
#      SPA fallback answering for a missing file), and on page when the HTML
#      has no app root;
#   8b. fail on cache-control when the summary carries none, on product when
#      the product endpoint answers with another product, on incidents alone
#      when only the incident list is missing, and with a timeout when the
#      API hangs;
#   8c. fail on deep-link alone when a product's page answers 404;
#   9. print a problem title that holds newlines and workflow commands on
#      one line, so a response cannot add GitHub workflow commands;
#  10. fail when the API is stopped, while the page still passes.
# Before those, it fails when the page polls an API path (the paths in
# frontend/src/hooks/useResources.ts) that the check does not fetch; after
# them, when a check the check's header lists failed in none of them.
# Then scripts/ops/synthetic-notify.sh:
#  11. its decision (page, recover or quiet) for a table of results and
#      earlier runs;
#  12. what it sends and marks, with a fake gh and a local receiver standing
#      in for the paging webhook and the heartbeat monitor: one page when an
#      episode starts, nothing while it lasts once a page was delivered, a
#      page again when the previous run's page was not delivered, a
#      recovery message when it ends, a heartbeat after every pass, a page
#      when earlier runs cannot be read, a retried webhook call, and exit 1
#      when the webhook keeps failing.
# Stops everything it started. Needs go, curl, jq and python3. Ports
# 18780-18789 by default (SELFTEST_PORT_BASE moves the block); CHECK_SHELL
# picks the shell that runs the check (default sh; dash is what Ubuntu's
# sh is). The check runs without GITHUB_ACTIONS, so its expected failures
# add no annotations to a CI run; case 9 sets it, and output lines that
# start with "::" are printed after "> ".
set -euo pipefail
# The defaults are under test, not the settings of whoever runs this.
unset MAX_AGE_SECONDS PRODUCT_ID TIMEOUT_SECONDS MAX_ASSETS

root="$(cd "$(dirname "$0")/../.." && pwd)"
check="$root/scripts/ops/synthetic-check.sh"
notifier="$root/scripts/ops/synthetic-notify.sh"
# The shell that runs the check; GitHub's ubuntu runners have dash as sh.
check_shell="${CHECK_SHELL:-sh}"
port_base="${SELFTEST_PORT_BASE:-18780}"
upstream_port=$port_base
api_port=$((port_base + 1))
admin_port=$((port_base + 2))
page_port=$((port_base + 3))
locked_port=$((port_base + 4))
locked_admin_port=$((port_base + 5))
dead_port=$((port_base + 6))
dead_admin_port=$((port_base + 7))
receiver_port=$((port_base + 8))
copy_port=$((port_base + 9))
work="$(mktemp -d)"
pids=()
api_pid=""
failures=0
cases=0

cleanup() {
  for pid in "${pids[@]:-}"; do
    [[ -n "$pid" ]] && { kill "$pid" 2>/dev/null; wait "$pid" 2>/dev/null; } || true
  done
  rm -rf "$work"
}
trap cleanup EXIT

for port in $(seq "$port_base" "$copy_port"); do
  if (exec 3<>"/dev/tcp/127.0.0.1/$port") 2>/dev/null; then
    echo "selftest: port $port is already in use; set SELFTEST_PORT_BASE" >&2
    exit 2
  fi
done

wait_for() {
  local url="$1"
  for _ in $(seq 1 150); do
    curl -fsS "$url" >/dev/null 2>&1 && return 0
    sleep 0.2
  done
  echo "selftest: $url never answered" >&2
  return 1
}

# broken MESSAGE records a failure found outside expect and notify.
broken() {
  echo "selftest: $1" >&2
  failures=$((failures + 1))
}

# render FILE PORT ADMIN_PORT [extra sed expressions]: config/FILE for the
# fixture upstream. Every kind polls every 10 minutes instead of 30 seconds
# or 5 minutes, so after the first round statusd does not rebuild and
# generated_at cannot move during the freshness case.
render() {
  local file="$1" port="$2" admin="$3"
  shift 3
  sed -E \
    -e "s#base_url: .*#base_url: http://127.0.0.1:${upstream_port}#" \
    -e "s#^  addr: .*#  addr: \"127.0.0.1:${port}\"#" \
    -e "s#^  admin_addr: .*#  admin_addr: \"127.0.0.1:${admin}\"#" \
    -e "s#^  (components|uptime|incidents)_interval: .*#  \\1_interval: 10m#" \
    -e "s#^  stale_after: .*#  stale_after: 20m#" \
    "$@" "$root/config/$file"
}

# answered PORT: the summary shows every source answered every kind once.
answered() {
  curl -fsS "http://127.0.0.1:$1/api/v1/summary" 2>/dev/null |
    jq -e '[.products[].checked_at[]] | length > 0 and all(. != null)' >/dev/null 2>&1
}

# generated_age PORT: seconds since the summary's generated_at.
generated_age() {
  curl -fsS "http://127.0.0.1:$1/api/v1/summary" | jq -r '(now | floor) - (.generated_at | fromdateiso8601)'
}

# expect NAME WANT_EXIT PATTERN [env assignments]: runs the check against the
# local API and page, prints its output, and records a failure when the exit
# code differs or PATTERN (an extended regex) does not match the output.
expect() {
  local name="$1" want="$2" pattern="$3" got=0
  shift 3
  cases=$((cases + 1))
  echo
  echo "== $name (want exit $want)"
  env -u GITHUB_ACTIONS STATUS_BASE_URL="http://127.0.0.1:${page_port}" STATUS_API_URL="http://127.0.0.1:${api_port}" \
    "$@" "$check_shell" "$check" >"$work/out" 2>&1 || got=$?
  sed 's/^\([[:space:]]*\)::/> \1::/' "$work/out"
  grep -oE '^FAIL [a-z-]+' "$work/out" | cut -d' ' -f2 >>"$work/failed" || true
  if [[ "$got" != "$want" ]]; then
    broken "$name exited $got, want $want"
  elif ! grep -Eq "$pattern" "$work/out"; then
    broken "$name output does not match /$pattern/"
  fi
}

# The API paths the page polls, with each ${...} as <id>, against the ones
# the check fetches, with each $variable as <id>.
cases=$((cases + 1))
echo "== the check fetches every API path the page polls"
# shellcheck disable=SC2016 # the patterns match a literal $ and backquote
polled="$(grep -oE '["`]/api/v1/[^"`]*' "$root/frontend/src/hooks/useResources.ts" |
  sed -E 's/^.//; s/\$\{[^}]*\}/<id>/g' | sort -u)"
# shellcheck disable=SC2016 # the patterns match a literal $
fetched="$(grep -oE '"\$api/api/v1/[^"]*' "$check" | sed -E 's/^"\$api//; s/\$[a-z_]+/<id>/g' | sort -u)"
printf 'polled:  %s\nfetched: %s\n' "$(paste -sd ' ' - <<<"$polled")" "$(paste -sd ' ' - <<<"$fetched")"
[[ -n "$polled" ]] || broken "found no /api/v1 path in frontend/src/hooks/useResources.ts"
while IFS= read -r path; do
  [[ -z "$path" ]] || grep -qxF -- "$path" <<<"$fetched" ||
    broken "the page polls $path, which synthetic-check.sh does not fetch"
done <<<"$polled"

(cd "$root/backend/go" && go build -o "$work/statusd" ./cmd/statusd)
(cd "$root/tests/contract" && go build -o "$work/upstream" ./cmd/upstream)

"$work/upstream" -addr "127.0.0.1:${upstream_port}" -dir "$root/testdata/upstream" >"$work/upstream.log" 2>&1 &
pids+=("$!")
wait_for "http://127.0.0.1:${upstream_port}/api/v1/monitors?cloud=moesif"

# page DIR SCRIPT: an index.html like the built one, loading SCRIPT.
page() {
  mkdir -p "$work/site/$1"
  cat >"$work/site/$1/index.html" <<HTML
<!doctype html>
<html lang="en">
  <head>
    <title>WSO2 Cloud Status</title>
    <script type="module" crossorigin src="$2"></script>
    <link rel="modulepreload" crossorigin href="/assets/vendor-selftest.js">
    <link rel="stylesheet" crossorigin href="/assets/index-selftest.css">
  </head>
  <body>
    <div id="root"></div>
  </body>
</html>
HTML
}
mkdir -p "$work/site/assets"
echo 'export const app = 1;' >"$work/site/assets/index-selftest.js"
echo 'export const vendor = 1;' >"$work/site/assets/vendor-selftest.js"
echo 'body { margin: 0; }' >"$work/site/assets/index-selftest.css"
echo '<!doctype html><div id="root"></div>' >"$work/site/assets/fallback.html"
page . /assets/index-selftest.js
page missing-asset /assets/index-missing.js
page html-asset /assets/fallback.html
page html-style /assets/index-selftest.js
sed -i.bak 's#/assets/index-selftest.css#/assets/fallback.html#' "$work/site/html-style/index.html"
page no-root /assets/index-selftest.js
sed -i.bak 's#<div id="root"></div>#<div id="app"></div>#' "$work/site/no-root/index.html"
page no-deep-link /assets/index-selftest.js
python3 -m http.server "$page_port" --bind 127.0.0.1 --directory "$work/site" >"$work/page.log" 2>&1 &
pids+=("$!")
wait_for "http://127.0.0.1:${page_port}/"

render statusd.yaml "$api_port" "$admin_port" >"$work/statusd.yaml"
STATUSD_CONFIG="$work/statusd.yaml" "$work/statusd" >"$work/statusd.log" 2>&1 &
api_pid=$!
pids+=("$api_pid")
wait_for "http://127.0.0.1:${api_port}/readyz"
for _ in $(seq 1 150); do
  answered "$api_port" && break
  sleep 0.2
done

# Deep links: the shell under /products/<id> for every product, as the
# frontend image serves it.
mkdir -p "$work/site/products"
for id in $(curl -fsS "http://127.0.0.1:${api_port}/api/v1/summary" | jq -r '.products[].id'); do
  cp "$work/site/index.html" "$work/site/products/$id"
done

total="$(curl -fsS "http://127.0.0.1:${api_port}/api/v1/summary" | jq '.products | length')"
expect "everything up" 0 '^synthetic check: all 9 passed$'
grep -Eq "^PASS data +$total of $total products have a known status$" "$work/out" ||
  broken "everything up: no PASS data line for $total of $total products"

# No poll is due for 10 minutes, so generated_at stays where the first round
# of polls left it; wait until it is at least 2 seconds old.
for _ in $(seq 1 30); do
  [[ "$(generated_age "$api_port")" -ge 2 ]] && break
  sleep 0.5
done
expect "generated_at older than the limit" 1 '^FAIL freshness +generated_at .* is [0-9]+s old, limit 1s$' MAX_AGE_SECONDS=1

# A local server for answers statusd does not give: under /old, an old copy
# of the API as an edge cache could serve it (the live summary, product and
# incident list with generated_at moved 7 minutes back and floored to the
# minute, served with the live Cache-Control); under /nocache, the live
# summary without Cache-Control; under /wrongid, a product endpoint that
# answers with another product; under /noincidents, the live API without its
# incident list; under /hang, nothing for 3 seconds; under /inject, a 503
# whose problem title holds newlines and workflow commands; under
# /unknown<N>, the live summary with its first N products unknown.
cat >"$work/copy.py" <<'PY'
import http.server, json, os, sys, time

root, cache = sys.argv[2], sys.argv[3]
title = "Down\n::add-mask::PASS\n::warning title=injected::text from the checked site"

class Handler(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        path = os.path.join(root, self.path.strip("/").replace("/", "_"))
        if self.path.startswith("/hang/"):
            time.sleep(3)
            return
        if self.path.startswith("/inject/"):
            body = json.dumps({"title": title, "status": 503}).encode()
            self.send_response(503)
            self.send_header("Content-Type", "application/problem+json")
        elif os.path.isfile(path):
            with open(path, "rb") as f:
                body = f.read()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            if not self.path.startswith("/nocache/"):
                self.send_header("Cache-Control", cache)
        else:
            body = b""
            self.send_response(404)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *args):
        pass

http.server.ThreadingHTTPServer(("127.0.0.1", int(sys.argv[1])), Handler).serve_forever()
PY
mkdir "$work/copy"
old="$(jq -nr 'now - 420 | floor | . - (. % 60) | todate')"
curl -fsS "http://127.0.0.1:${api_port}/api/v1/summary" | jq --arg t "$old" '.generated_at = $t' \
  >"$work/copy/old_api_v1_summary"
curl -fsS "http://127.0.0.1:${api_port}/api/v1/products/moesif" | jq --arg t "$old" '.generated_at = $t' \
  >"$work/copy/old_api_v1_products_moesif"
curl -fsS "http://127.0.0.1:${api_port}/api/v1/incidents" | jq --arg t "$old" '.generated_at = $t' \
  >"$work/copy/old_api_v1_incidents"
for dir in nocache wrongid noincidents; do
  curl -fsS "http://127.0.0.1:${api_port}/api/v1/summary" >"$work/copy/${dir}_api_v1_summary"
done
curl -fsS "http://127.0.0.1:${api_port}/api/v1/products/moesif" >"$work/copy/noincidents_api_v1_products_moesif"
curl -fsS "http://127.0.0.1:${api_port}/api/v1/products/developer-platform" >"$work/copy/wrongid_api_v1_products_moesif"
# The critical alert's point: more than half the products unknown.
half=$((total / 2))
for n in "$half" "$((half + 1))"; do
  curl -fsS "http://127.0.0.1:${api_port}/api/v1/summary" |
    jq --argjson n "$n" '.status = "unknown" | .data_complete = false
      | .products |= [to_entries[] | if .key < $n then .value.status = "unknown" else . end | .value]' \
    >"$work/copy/unknown${n}_api_v1_summary"
  curl -fsS "http://127.0.0.1:${api_port}/api/v1/products/moesif" >"$work/copy/unknown${n}_api_v1_products_moesif"
  curl -fsS "http://127.0.0.1:${api_port}/api/v1/incidents" >"$work/copy/unknown${n}_api_v1_incidents"
done
cache_control="$(curl -fsS -o /dev/null -D - "http://127.0.0.1:${api_port}/api/v1/summary" | tr -d '\r' |
  awk 'tolower($0) ~ /^cache-control:/ { sub(/^[^:]*:[ \t]*/, ""); print }')"
python3 -I "$work/copy.py" "$copy_port" "$work/copy" "$cache_control" >"$work/copy.log" 2>&1 &
pids+=("$!")
wait_for "http://127.0.0.1:${copy_port}/old/api/v1/summary"
expect "an old copy, older than the page's limit and younger than 10 minutes" 1 \
  '^FAIL freshness +generated_at .* is [0-9]+s old, limit 300s$' \
  STATUS_API_URL="http://127.0.0.1:${copy_port}/old" PRODUCT_ID=moesif
age="$(sed -nE 's/^FAIL freshness +generated_at .* is ([0-9]+)s old, limit 300s$/\1/p' "$work/out")"
if [[ -z "$age" || "$age" -le 300 || "$age" -gt 600 ]]; then
  broken "old copy: generated_at is ${age:-?}s old, want between 300 and 600"
fi
grep -Eq '^FAIL incidents +.* generated_at .* is [0-9]+s old, limit 300s$' "$work/out" ||
  broken "old copy: no FAIL incidents line for the old incident list"
[[ "$(grep -c '^FAIL' "$work/out")" == 2 ]] || broken "old copy: freshness and incidents should be the only failures"
expect "half the products unknown" 0 "^PASS data +$((total - half)) of $total products have a known status\$" \
  STATUS_API_URL="http://127.0.0.1:${copy_port}/unknown${half}" PRODUCT_ID=moesif
expect "more than half the products unknown" 1 "^FAIL data +$((half + 1)) of $total products have no known status " \
  STATUS_API_URL="http://127.0.0.1:${copy_port}/unknown$((half + 1))" PRODUCT_ID=moesif
[[ "$(grep -c '^FAIL' "$work/out")" == 1 ]] || broken "more than half unknown: data should be the only failure"

# Identity Platform's source (backend asgardeo) answers 404 to everything.
render statusd.yaml "$dead_port" "$dead_admin_port" \
  -e "/^  asgardeo:/,/base_url:/ s#base_url: .*#base_url: http://127.0.0.1:${upstream_port}/no-such-api#" >"$work/dead.yaml"
STATUSD_CONFIG="$work/dead.yaml" "$work/statusd" >"$work/dead.log" 2>&1 &
dead_pid=$!
pids+=("$dead_pid")
wait_for "http://127.0.0.1:${dead_port}/readyz"
expect "one source never answered" 0 \
  '^INFO summary +identity-platform: status unknown, .*last checked: components never, incidents never, uptime never$' \
  STATUS_API_URL="http://127.0.0.1:${dead_port}"
grep -q '^synthetic check: all 9 passed$' "$work/out" || broken "one source never answered: every check should pass"
kill "$dead_pid"
wait "$dead_pid" 2>/dev/null || true

# The backend that serves every product but Identity Platform (backend
# cloudservices) answers 404 to everything: most products unknown.
render statusd.yaml "$dead_port" "$dead_admin_port" \
  -e "/^  cloudservices:/,/base_url:/ s#base_url: .*#base_url: http://127.0.0.1:${upstream_port}/no-such-api#" >"$work/shared.yaml"
STATUSD_CONFIG="$work/shared.yaml" "$work/statusd" >"$work/shared.log" 2>&1 &
dead_pid=$!
pids+=("$dead_pid")
wait_for "http://127.0.0.1:${dead_port}/readyz"
expect "the shared backend is dead" 1 \
  "^FAIL data +[0-9]+ of $total products have no known status \\(overall status \"unknown\"\\): the page reads \"Status unavailable\" for them\$" \
  STATUS_API_URL="http://127.0.0.1:${dead_port}"
grep -q '^PASS freshness ' "$work/out" || broken "the shared backend is dead: freshness should pass"
kill "$dead_pid"
wait "$dead_pid" 2>/dev/null || true

# Every source answers 404 from the start: statusd answers and is fresh,
# with every product unknown. Its readiness probe stays 503, so this waits
# for the summary instead.
render statusd.yaml "$dead_port" "$dead_admin_port" \
  -e "s#base_url: .*#base_url: http://127.0.0.1:${upstream_port}/no-such-api#" >"$work/nodata.yaml"
STATUSD_CONFIG="$work/nodata.yaml" "$work/statusd" >"$work/nodata.log" 2>&1 &
dead_pid=$!
pids+=("$dead_pid")
wait_for "http://127.0.0.1:${dead_port}/api/v1/summary"
expect "no product has a known status" 1 \
  "^FAIL data +$total of $total products have no known status \\(overall status \"unknown\"\\): the page reads \"Status unavailable\" for them\$" \
  STATUS_API_URL="http://127.0.0.1:${dead_port}"
grep -q '^PASS freshness ' "$work/out" || broken "no product has a known status: freshness should pass"
kill "$dead_pid"
wait "$dead_pid" 2>/dev/null || true

render statusd.production.yaml "$locked_port" "$locked_admin_port" >"$work/locked.yaml"
FRONT_DOOR_ID=selftest-front-door STATUSD_CONFIG="$work/locked.yaml" "$work/statusd" >"$work/locked.log" 2>&1 &
pids+=("$!")
wait_for "http://127.0.0.1:${locked_port}/readyz"
expect "origin lock rejects the caller" 1 '^FAIL summary +.* answered HTTP 403, want 200 \("Forbidden"\)$' \
  STATUS_API_URL="http://127.0.0.1:${locked_port}" PRODUCT_ID=moesif

expect "page references a missing script" 1 \
  '^FAIL assets +http://127\.0\.0\.1:[0-9]+/assets/index-missing\.js answered HTTP 404, want 200$' \
  STATUS_BASE_URL="http://127.0.0.1:${page_port}/missing-asset"
expect "a script answers with HTML" 1 \
  '^FAIL assets +http://127\.0\.0\.1:[0-9]+/assets/fallback\.html answered 200 with Content-Type "text/html.*", want JavaScript$' \
  STATUS_BASE_URL="http://127.0.0.1:${page_port}/html-asset"
expect "a stylesheet answers with HTML" 1 \
  '^FAIL assets +http://127\.0\.0\.1:[0-9]+/assets/fallback\.html answered 200 with Content-Type "text/html.*", want CSS$' \
  STATUS_BASE_URL="http://127.0.0.1:${page_port}/html-style"
expect "the page has no app root" 1 \
  '^FAIL page +http://127\.0\.0\.1:[0-9]+/no-root/ answered 200 but the HTML has no app root' \
  STATUS_BASE_URL="http://127.0.0.1:${page_port}/no-root"
expect "a product's page answers 404" 1 \
  '^FAIL deep-link +http://127\.0\.0\.1:[0-9]+/no-deep-link/products/moesif answered HTTP 404, want 200' \
  STATUS_BASE_URL="http://127.0.0.1:${page_port}/no-deep-link" PRODUCT_ID=moesif
[[ "$(grep -c '^FAIL' "$work/out")" == 1 ]] || broken "a product's page answers 404: deep-link should be the only failure"
expect "the summary has no Cache-Control" 1 '^FAIL cache-control +the summary has no Cache-Control header$' \
  STATUS_API_URL="http://127.0.0.1:${copy_port}/nocache" PRODUCT_ID=nosuch
expect "the product endpoint answers with another product" 1 \
  '^FAIL product +.* answered 200 but the body is not product "moesif" with a string "status"$' \
  STATUS_API_URL="http://127.0.0.1:${copy_port}/wrongid" PRODUCT_ID=moesif
expect "only the incident list fails" 1 \
  '^FAIL incidents +http://127\.0\.0\.1:[0-9]+/noincidents/api/v1/incidents answered HTTP 404, want 200$' \
  STATUS_API_URL="http://127.0.0.1:${copy_port}/noincidents" PRODUCT_ID=moesif
[[ "$(grep -c '^FAIL' "$work/out")" == 1 ]] || broken "only the incident list fails: incidents should be the only failure"
expect "the API hangs" 1 '^FAIL summary +.* request failed: curl: \(28\)' \
  STATUS_API_URL="http://127.0.0.1:${copy_port}/hang" TIMEOUT_SECONDS=1

# On a runner (GITHUB_ACTIONS=true): only the check's own annotations may
# start a line with "::".
expect "a problem title cannot add workflow commands" 1 \
  '^FAIL summary +.* answered HTTP 503, want 200 \("Down ::add-mask::PASS ::warning title=injected::text from the checked site"\)$' \
  GITHUB_ACTIONS=true STATUS_API_URL="http://127.0.0.1:${copy_port}/inject"
if grep -E '^[[:space:]]*::' "$work/out" | grep -vq '^::error title=synthetic [a-z-]*::'; then
  broken "problem title: a line other than the check's own annotations starts with ::"
fi
grep -q '^::error title=synthetic summary::' "$work/out" || broken "problem title: no ::error annotation for the summary"

kill "$api_pid"
wait "$api_pid" 2>/dev/null || true
expect "API stopped" 1 '^FAIL summary +.* request failed: '
grep -q '^PASS assets ' "$work/out" || broken "API stopped: the page's assets should still pass"

cases=$((cases + 1))
echo
echo "== every check has a case that makes it fail"
checks="$(sed -n '/^# Checks:/,/^# Prints/ s/^#   \([a-z][a-z-]*\) .*/\1/p' "$check")"
echo "checks: $(paste -sd ' ' - <<<"$checks")"
[[ -n "$checks" ]] || broken "found no check names under '# Checks:' in synthetic-check.sh"
for name in $checks; do
  grep -qxF "$name" "$work/failed" || broken "no case makes the $name check fail"
done

# 11. The notifier's decision.
echo
echo "== notifier decisions"
decide_case() {
  local want="$1" got
  shift
  got="$("$check_shell" "$notifier" decide "$@")"
  printf '%-40s -> %s\n' "$*" "$got"
  [[ "$got" == "$want" ]] || broken "decide $* printed $got, want $want"
}
cases=$((cases + 1))
decide_case page fail success
decide_case page fail
decide_case page fail cancelled success
decide_case page fail unknown
decide_case quiet fail failure:paged success
decide_case quiet fail cancelled skipped failure:paged
decide_case quiet fail timed_out:paged
decide_case page fail failure success
decide_case page fail cancelled timed_out
decide_case page fail startup_failure
decide_case recover pass failure
decide_case recover pass failure:paged
decide_case recover pass cancelled startup_failure
decide_case quiet pass success failure
decide_case quiet pass
decide_case quiet pass unknown

# 12. What the notifier sends. The receiver logs one line per request:
# method, path and the JSON-quoted body. /broken always answers 500; /flaky
# answers 503 to its first request and 200 after that.
cat >"$work/receiver.py" <<'PY'
import http.server, json, sys

class Handler(http.server.BaseHTTPRequestHandler):
    flaky = 0

    def handle_one(self):
        length = int(self.headers.get("Content-Length") or 0)
        body = self.rfile.read(length).decode() if length else ""
        with open(sys.argv[2], "a") as log:
            log.write(f"{self.command} {self.path} {json.dumps(body)}\n")
        status = 200
        if self.path.startswith("/broken"):
            status = 500
        elif self.path.startswith("/flaky"):
            Handler.flaky += 1
            status = 503 if Handler.flaky == 1 else 200
        self.send_response(status)
        self.send_header("Content-Length", "0")
        self.end_headers()

    do_GET = do_POST = handle_one

    def log_message(self, *args):
        pass

http.server.HTTPServer(("127.0.0.1", int(sys.argv[1])), Handler).serve_forever()
PY
: >"$work/receiver.log"
python3 -I "$work/receiver.py" "$receiver_port" "$work/receiver.log" >"$work/receiver.out" 2>&1 &
pids+=("$!")
for _ in $(seq 1 50); do
  (exec 3<>"/dev/tcp/127.0.0.1/$receiver_port") 2>/dev/null && break
  sleep 0.1
done

# The fake gh answers "run list" with FAKE_GH_RUNS ("ID:CONCLUSION ...",
# newest first, printed as the notifier's --jq would) and "api
# .../runs/ID/artifacts" with the number of live synthetic-paged artifacts:
# 1 for the ids in FAKE_GH_PAGED, else 0. FAKE_GH_FAIL=1 fails "run list";
# FAKE_GH_API_FAIL=1 fails "api".
mkdir "$work/bin"
cat >"$work/bin/gh" <<'GH'
#!/bin/sh
printf '%s\n' "$*" >>"$FAKE_GH_LOG"
case $1 in
  run)
    if [ "${FAKE_GH_FAIL:-}" = 1 ]; then
      echo "HTTP 403: Resource not accessible by integration" >&2
      exit 1
    fi
    for r in ${FAKE_GH_RUNS:-}; do echo "${r%%:*} ${r#*:}"; done
    ;;
  api)
    if [ "${FAKE_GH_API_FAIL:-}" = 1 ]; then
      echo "HTTP 502: Bad Gateway" >&2
      exit 1
    fi
    id=${2%/artifacts}
    id=${id##*/}
    case " ${FAKE_GH_PAGED:-} " in *" $id "*) echo 1 ;; *) echo 0 ;; esac
    ;;
  *) exit 1 ;;
esac
GH
chmod +x "$work/bin/gh"
printf '%s\n' 'PASS page          up' \
  'FAIL freshness     generated_at 2026-10-21T14:05:00Z is 900s old, limit 300s' \
  'FAIL summary       answered HTTP 503, want 200 ("<users/all> <https://example.invalid|open>")' >"$work/check.out"

# notify NAME WANT_EXIT WANT_REQUESTS WANT_MARK RESULT [env assignments]:
# runs the notifier as run 2. WANT_REQUESTS lists what the receiver got, in
# order, as "METHOD PATH[ page|recovery]" joined by ";", or "" for nothing.
# WANT_MARK is yes when the run must mark its episode as paged (paged=true
# in GITHUB_OUTPUT and PAGED_FILE written), no when it must not.
notify() {
  local name="$1" want="$2" want_requests="$3" want_mark="$4" result="$5" got=0 requests mark=no
  shift 5
  cases=$((cases + 1))
  : >"$work/receiver.log"
  : >"$work/gh-output"
  : >"$work/gh.log"
  rm -f "$work/paged.txt"
  echo
  echo "== notify: $name (want exit $want)"
  env PATH="$work/bin:$PATH" FAKE_GH_LOG="$work/gh.log" CHECK_OUTPUT="$work/check.out" \
    STATUS_BASE_URL=https://status.example RUN_URL=https://runs.example/2 CURRENT_RUN_ID=2 \
    PAGING_WEBHOOK="http://127.0.0.1:${receiver_port}/webhook" \
    HEARTBEAT_URL="http://127.0.0.1:${receiver_port}/heartbeat" \
    GITHUB_OUTPUT="$work/gh-output" PAGED_FILE="$work/paged.txt" RETRY_DELAY_SECONDS=1 \
    "$@" "$check_shell" "$notifier" run "$result" >"$work/out" 2>&1 || got=$?
  cat "$work/out"
  requests="$(awk '{ kind = ""; if (/failed for/) kind = " page"; else if (/passed again/) kind = " recovery"
    print $1 " " $2 kind }' "$work/receiver.log" | paste -sd ';' -)"
  if grep -qx 'paged=true' "$work/gh-output" && [[ -s "$work/paged.txt" ]]; then
    mark=yes
  fi
  echo "receiver: ${requests:-(nothing)}; marked as paged: $mark"
  if [[ "$got" != "$want" ]]; then
    broken "notify: $name exited $got, want $want"
  elif [[ "$requests" != "$want_requests" ]]; then
    broken "notify: $name sent \"$requests\", want \"$want_requests\""
  elif [[ "$mark" != "$want_mark" ]]; then
    broken "notify: $name marked its episode as paged: $mark, want $want_mark"
  fi
}

notify "a failure episode starts" 0 "POST /webhook page" yes fail FAKE_GH_RUNS="11:cancelled 10:success"
grep -q 'FAIL freshness' "$work/receiver.log" || broken "notify: the page does not quote the check's FAIL lines"
if ! grep -q 'users/all' "$work/receiver.log" || grep -q '[<>]' "$work/receiver.log"; then
  broken "notify: the page should quote the FAIL lines without < and >"
fi
grep -q -- '--event schedule --status completed' "$work/gh.log" ||
  broken "notify: gh was not asked for completed scheduled runs"
if grep -q '^api ' "$work/gh.log"; then
  broken "notify: artifacts were looked up although the previous run passed"
fi

notify "the episode goes on after a delivered page" 0 "" yes fail FAKE_GH_RUNS="11:failure 10:success" FAKE_GH_PAGED=11
grep -q '^api repos/{owner}/{repo}/actions/runs/11/artifacts ' "$work/gh.log" ||
  broken "notify: the previous failing run's artifacts were not looked up"
notify "the previous run's page was not delivered" 0 "POST /webhook page" yes fail \
  FAKE_GH_RUNS="11:failure 10:success" FAKE_GH_PAGED=10
notify "the mark cannot be read" 0 "POST /webhook page" yes fail FAKE_GH_RUNS="11:failure" FAKE_GH_API_FAIL=1
notify "the episode ends" 0 "POST /webhook recovery;GET /heartbeat" no pass FAKE_GH_RUNS="11:failure" FAKE_GH_PAGED=11
notify "all well" 0 "GET /heartbeat" no pass FAKE_GH_RUNS="11:success"
notify "earlier runs cannot be read" 0 "POST /webhook page" yes fail FAKE_GH_FAIL=1
notify "no webhook set, passing" 0 "GET /heartbeat" no pass FAKE_GH_RUNS="11:failure" PAGING_WEBHOOK=
notify "no webhook set, failing" 0 "" no fail FAKE_GH_RUNS="11:success" PAGING_WEBHOOK=
notify "the webhook fails once, then accepts the retry" 0 "POST /flaky page;POST /flaky page" yes fail \
  FAKE_GH_RUNS="11:success" PAGING_WEBHOOK="http://127.0.0.1:${receiver_port}/flaky"
notify "the webhook keeps failing" 1 "POST /broken page;POST /broken page;POST /broken page;POST /broken page" no fail \
  FAKE_GH_RUNS="11:success" PAGING_WEBHOOK="http://127.0.0.1:${receiver_port}/broken"

echo
if [[ "$failures" -gt 0 ]]; then
  echo "selftest: $failures failure(s) in $cases case(s)" >&2
  exit 1
fi
echo "selftest: all $cases cases behaved as expected"
