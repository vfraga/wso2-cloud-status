#!/bin/sh
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

# External synthetic check of the public status page and its API, through
# the same address customers use (CDN included).
#
#   scripts/ops/synthetic-check.sh https://status.cloud.wso2.com
#
# Checks:
#   page          GET <base>/ answers 200 with HTML that holds the app root
#                 (id="root").
#   assets        every module script, module preload and stylesheet that
#                 page references answers 200 with a JavaScript or CSS
#                 content type and a body (the first MAX_ASSETS of them). A
#                 missing bundle leaves the page blank although it answers
#                 200, for example after a deploy that served a new
#                 index.html with assets an origin does not have.
#   summary       GET <api>/api/v1/summary answers 200 with a JSON object
#                 whose "status" is a string.
#   cache-control the summary carries Cache-Control.
#   freshness     the summary's generated_at, when statusd built the
#                 snapshot (floored to the minute), is no older than
#                 MAX_AGE_SECONDS. A frozen snapshot or an old CDN copy ages
#                 it; one silent upstream source does not, and shows as an
#                 INFO line instead (the page already reports that product
#                 as unavailable).
#   data          most products have a known status (not "unknown"). When
#                 more than half have none, the page reads "Status
#                 unavailable" for them although statusd is up and fresh: a
#                 shared upstream, its gateway or token issuer, or statusd's
#                 own egress is failing. StatusdNoProductData turns critical
#                 at the same point.
#   product       GET <api>/api/v1/products/<id> answers 200 with that
#                 product as JSON.
#   incidents     GET <api>/api/v1/incidents answers 200 with a JSON object
#                 whose generated_at is no older than MAX_AGE_SECONDS.
#   deep-link     GET <base>/products/<id> and <base>/history answer 200
#                 with HTML that holds the app root: links to a product's
#                 page and to the incident history.
# Prints one PASS, FAIL or SKIP line per check (SKIP when a failed check
# leaves nothing to check), INFO lines for what the page currently shows
# (each product that is unknown, incomplete or stale, with the age of its
# last successful checks), and exits 0 when every check passed, 1 when any
# failed, 2 on a usage error. Text taken from the responses is printed on
# one line, without control characters and at most 500 characters long, so
# a response cannot add lines (or GitHub workflow commands) to the output.
# Needs curl and jq (both on GitHub-hosted runners).
#
# Environment (the first argument overrides STATUS_BASE_URL):
#   STATUS_BASE_URL  page address, for example https://status.cloud.wso2.com
#   STATUS_API_URL   API address when it is not the page address (local
#                    tests); default STATUS_BASE_URL
#   MAX_AGE_SECONDS  oldest acceptable generated_at; default 300, the
#                    page's own limit (staleAfterMs in frontend/src/config.ts):
#                    past it every visitor reads "Status unavailable", so the
#                    check fails when they do. statusd rebuilds after every
#                    poll (30 s) and floors the time to the minute, so a
#                    healthy age is under about 2 minutes including CDN
#                    caching.
#   PRODUCT_ID       product to fetch and link to; default the first one in
#                    the summary
#   TIMEOUT_SECONDS  limit per request; default 15
#   MAX_ASSETS       most page assets to fetch; default 5
set -u

usage() {
  echo "synthetic: $1" >&2
  echo "usage: $0 <base URL>   (or set STATUS_BASE_URL)" >&2
  exit 2
}

trim() {
  t=$1
  while [ "${t%/}" != "$t" ]; do t=${t%/}; done
  printf '%s' "$t"
}

base=$(trim "${1:-${STATUS_BASE_URL:-}}")
api=$(trim "${STATUS_API_URL:-$base}")
max_age=${MAX_AGE_SECONDS:-300}
timeout=${TIMEOUT_SECONDS:-15}
max_assets=${MAX_ASSETS:-5}
product=${PRODUCT_ID:-}

case $base in
  http://* | https://*) ;;
  *) usage "the base URL must start with http:// or https://, got '$base'" ;;
esac
case $api in
  http://* | https://*) ;;
  *) usage "STATUS_API_URL must start with http:// or https://, got '$api'" ;;
esac
case $max_age in '' | *[!0-9]*) usage "MAX_AGE_SECONDS must be a whole number of seconds" ;; esac
case $timeout in '' | *[!0-9]* | 0) usage "TIMEOUT_SECONDS must be a positive whole number" ;; esac
case $max_assets in '' | *[!0-9]* | 0) usage "MAX_ASSETS must be a positive whole number" ;; esac
case $product in *[!a-z0-9-]*) usage "PRODUCT_ID must be a product id such as developer-platform" ;; esac
for tool in curl jq; do
  command -v "$tool" >/dev/null 2>&1 || usage "$tool is required"
done

work=$(mktemp -d) || exit 2
trap 'rm -rf "$work"' EXIT
trap 'exit 2' HUP INT TERM

# Request ids let a failure be found in the statusd logs when the request
# reached the origin (5xx are logged at error level with their request id).
rid="synthetic-$(date -u +%Y%m%dT%H%M%SZ)-$$"
agent="wso2-cloud-status-synthetic/1"
passed=0
failed=0
skipped=0

# line TEXT prints TEXT on one line: control characters (a newline in a
# problem title, for example) become spaces and it is cut at 500
# characters. Every message goes through it, because parts of them come from
# the checked site, and a line that starts with "::" is a workflow command
# on GitHub Actions.
line() {
  printf '%s' "$1" | tr '\001-\037\177' ' ' | cut -c 1-500
}

pass() {
  passed=$((passed + 1))
  printf 'PASS %-13s %s\n' "$1" "$(line "$2")"
}

# fail also writes an error annotation on GitHub Actions; its message is
# encoded the way the runner decodes workflow command data.
fail() {
  failed=$((failed + 1))
  msg=$(line "$2")
  printf 'FAIL %-13s %s\n' "$1" "$msg"
  if [ "${GITHUB_ACTIONS:-}" = true ]; then
    printf '::error title=synthetic %s::%s\n' "$1" "$(printf '%s' "$msg" | sed 's/%/%25/g')"
  fi
}

skip() {
  skipped=$((skipped + 1))
  printf 'SKIP %-13s not checked: %s\n' "$1" "$(line "$2")"
}

info() {
  printf 'INFO %-13s %s\n' "$1" "$(line "$2")"
}

# fetch NAME URL: GETs URL into $work/NAME.body and $work/NAME.headers and
# sets code. On a transport failure (DNS, TLS, refused, timeout) it returns 1
# with the reason in fetch_error.
fetch() {
  code=$(curl -sS --compressed --max-time "$timeout" -A "$agent" \
    -H "X-Request-ID: $rid-$1" \
    -o "$work/$1.body" -D "$work/$1.headers" -w '%{http_code}' "$2" 2>"$work/$1.err")
  status=$?
  if [ "$status" -ne 0 ]; then
    fetch_error="request failed: $(tr -d '\r' <"$work/$1.err" | head -n 1)"
    return 1
  fi
  return 0
}

# header NAME FIELD prints the value of response header FIELD of fetch NAME.
header() {
  [ -f "$work/$1.headers" ] || return 0
  tr -d '\r' <"$work/$1.headers" | awk -v field="$2" '
    index($0, ":") > 0 {
      name = tolower(substr($0, 1, index($0, ":") - 1))
      if (name == tolower(field)) { value = substr($0, index($0, ":") + 1); sub(/^[ \t]+/, "", value) }
    }
    END { if (value != "") print value }'
}

# why NAME describes a non-200 answer: the problem title statusd sends, and
# the edge reference Azure Front Door adds, when present.
why() {
  title=$(jq -r 'if type == "object" then .title // empty else empty end' "$work/$1.body" 2>/dev/null)
  ref=$(header "$1" X-Azure-Ref)
  out=""
  [ -n "$title" ] && out=" (\"$title\")"
  [ -n "$ref" ] && out="$out, X-Azure-Ref $ref"
  printf '%s' "$out"
}

# generated_at NAME prints the generated_at of fetch NAME's JSON object.
generated_at() {
  jq -r 'if type == "object" then .generated_at // empty else empty end' "$work/$1.body" 2>/dev/null
}

# age_of TIME prints how many seconds ago TIME, RFC 3339 in UTC, was.
age_of() {
  jq -nr --arg t "$1" '(now | floor) - ($t | fromdateiso8601)' 2>/dev/null
}

check_page() {
  url="$base/"
  page_ok=false
  if ! fetch page "$url"; then
    fail page "$url $fetch_error"
  elif [ "$code" != 200 ]; then
    fail page "$url answered HTTP $code, want 200$(why page)"
  elif ! grep -q 'id="root"' "$work/page.body"; then
    fail page "$url answered 200 but the HTML has no app root (id=\"root\")"
  else
    pass page "$url answered 200 with the app root"
    page_ok=true
  fi
}

# asset_refs prints "js URL" or "css URL" for each module script, module
# preload and stylesheet in the page, in order, without repeats.
asset_refs() {
  tr '\r\n' '  ' <"$work/page.body" | grep -oE '<(script|link)[[:space:]][^>]*>' |
    while IFS= read -r tag; do
      case $tag in
        '<script'*)
          case $tag in *'type="module"'* | *"type='module'"*) ;; *) continue ;; esac
          kind=js attr=src
          ;;
        *'rel="stylesheet"'* | *"rel='stylesheet'"*) kind=css attr=href ;;
        *'rel="modulepreload"'* | *"rel='modulepreload'"*) kind=js attr=href ;;
        *) continue ;;
      esac
      ref=$(printf '%s\n' "$tag" | sed -nE "s/.*[[:space:]]$attr=[\"']([^\"']*)[\"'].*/\\1/p")
      [ -n "$ref" ] && printf '%s %s\n' "$kind" "$ref"
    done | awk '!seen[$0]++'
}

# resolve REF prints the absolute URL of a reference in the page.
resolve() {
  case $1 in
    http://* | https://*) printf '%s' "$1" ;;
    //*) printf '%s%s' "${base%%://*}:" "$1" ;;
    /*) printf '%s%s' "$(printf '%s' "$base" | sed -E 's#^([a-z]+://[^/]+).*#\1#')" "$1" ;;
    *) printf '%s/%s' "$base" "${1#./}" ;;
  esac
}

check_assets() {
  if [ "$page_ok" != true ]; then
    skip assets "no page to read the scripts and stylesheets from"
    return
  fi
  asset_refs >"$work/assets.list"
  total=$(wc -l <"$work/assets.list" | tr -d ' ')
  if [ "$total" -eq 0 ]; then
    fail assets "$base/ references no module script or stylesheet, so the app cannot start"
    return
  fi
  n=0
  bad=0
  while IFS=' ' read -r kind ref <&3; do
    if [ "$n" -ge "$max_assets" ]; then
      info assets "$((total - n)) more not fetched (MAX_ASSETS=$max_assets)"
      break
    fi
    n=$((n + 1))
    url=$(resolve "$ref")
    if ! fetch "asset$n" "$url"; then
      fail assets "$url $fetch_error"
      bad=$((bad + 1))
      [ "$n" -lt "$total" ] && info assets "the remaining assets were not fetched after a request failed"
      break
    fi
    type=$(header "asset$n" Content-Type | tr '[:upper:]' '[:lower:]')
    case $kind:$type in
      js:application/javascript* | js:text/javascript* | js:application/x-javascript* | js:application/ecmascript* | js:text/ecmascript*) type_ok=true ;;
      css:text/css*) type_ok=true ;;
      *) type_ok=false ;;
    esac
    if [ "$code" != 200 ]; then
      fail assets "$url answered HTTP $code, want 200$(why "asset$n")"
      bad=$((bad + 1))
    elif [ "$type_ok" != true ]; then
      fail assets "$url answered 200 with Content-Type \"$type\", want $( [ "$kind" = js ] && echo JavaScript || echo CSS)"
      bad=$((bad + 1))
    elif [ ! -s "$work/asset$n.body" ]; then
      fail assets "$url answered 200 with an empty body"
      bad=$((bad + 1))
    fi
  done 3<"$work/assets.list"
  if [ "$bad" -eq 0 ]; then
    pass assets "$n script and stylesheet file(s) answered 200 with a JavaScript or CSS type"
  fi
}

check_summary() {
  url="$api/api/v1/summary"
  if ! fetch summary "$url"; then
    fail summary "$url $fetch_error"
    skip cache-control "no summary response"
    skip freshness "no summary response"
    skip data "no summary response"
    return
  fi
  if [ "$code" != 200 ]; then
    fail summary "$url answered HTTP $code, want 200$(why summary)"
    skip cache-control "the summary answered HTTP $code"
    skip freshness "the summary answered HTTP $code"
    skip data "the summary answered HTTP $code"
    return
  fi
  summary_ok=false
  if jq -e 'type == "object" and (.status | type == "string")' "$work/summary.body" >/dev/null 2>&1; then
    pass summary "$url answered 200, overall status \"$(jq -r .status "$work/summary.body")\""
    summary_ok=true
  else
    fail summary "$url answered 200 but the body is not a JSON object with a string \"status\""
  fi

  cache=$(header summary Cache-Control)
  if [ -n "$cache" ]; then
    pass cache-control "Cache-Control: $cache"
  else
    fail cache-control "the summary has no Cache-Control header"
  fi

  generated=$(generated_at summary)
  if [ -z "$generated" ]; then
    fail freshness "the summary has no generated_at"
  elif ! age=$(age_of "$generated") || [ -z "$age" ]; then
    fail freshness "generated_at \"$generated\" is not an RFC 3339 UTC time"
  elif [ "$age" -gt "$max_age" ]; then
    fail freshness "generated_at $generated is ${age}s old, limit ${max_age}s"
  else
    pass freshness "generated_at $generated is ${age}s old, limit ${max_age}s"
  fi
  check_data
}

# check_data fails when more than half the products have no known status.
check_data() {
  if [ "$summary_ok" != true ]; then
    skip data "the summary is not a JSON object with a string \"status\""
    return
  fi
  counts=$(jq -r '[((.products // []) | length), ([(.products // [])[] | select(.status != "unknown")] | length)] | @tsv' \
    "$work/summary.body" 2>/dev/null)
  total=$(printf '%s' "$counts" | cut -f 1)
  known=$(printf '%s' "$counts" | cut -f 2)
  overall=$(jq -r .status "$work/summary.body")
  case $total:$known in
    *[!0-9:]* | :* | *:) fail data "the summary's products are not a list of products with a status" ;;
    0:*) fail data "the summary lists no products, so the page shows none" ;;
    *)
      unknown=$((total - known))
      if [ $((unknown * 2)) -gt "$total" ]; then
        fail data "$unknown of $total products have no known status (overall status \"$overall\"): the page reads \"Status unavailable\" for them"
      else
        pass data "$known of $total products have a known status"
      fi
      ;;
  esac
}

# describe prints what the page shows, for whoever reads a failed run. It
# never fails the check: an unknown or stale product is reported by the
# alerts, and by the page itself.
describe() {
  [ "$code" = 200 ] || return 0
  jq -r '
    def ago: if . == null then "never" else "\((now | floor) - fromdateiso8601)s ago" end;
    "data_complete \(if has("data_complete") then .data_complete else "(not sent)" end), \(.active_incidents | length) active incident(s)",
    (.products[]?
      | select(.status == "unknown" or .data_complete == false or .outdated == true
          or ((.stale // {}) | to_entries | any(.value == true)))
      | "\(.id): status \(.status), data_complete \(.data_complete), outdated \(.outdated)"
        + (if (.stale // {}) | to_entries | any(.value == true)
           then ", stale \([.stale | to_entries[] | select(.value == true) | .key] | join(" "))" else "" end)
        + (if .checked_at then "; last checked: components \(.checked_at.components | ago), incidents \(.checked_at.incidents | ago), uptime \(.checked_at.uptime | ago)" else "" end))
  ' "$work/summary.body" 2>/dev/null | while IFS= read -r line; do info summary "$line"; done
}

check_product() {
  id=$product
  if [ -z "$id" ] && [ -f "$work/summary.body" ]; then
    id=$(jq -r 'if type == "object" then .products[0].id // empty else empty end' "$work/summary.body" 2>/dev/null)
  fi
  if [ -z "$id" ]; then
    skip product "PRODUCT_ID is unset and there is no summary to take a product from"
    return
  fi
  url="$api/api/v1/products/$id"
  if ! fetch product "$url"; then
    fail product "$url $fetch_error"
  elif [ "$code" != 200 ]; then
    fail product "$url answered HTTP $code, want 200$(why product)"
  elif ! jq -e --arg id "$id" 'type == "object" and .id == $id and (.status | type == "string")' "$work/product.body" >/dev/null 2>&1; then
    fail product "$url answered 200 but the body is not product \"$id\" with a string \"status\""
  else
    pass product "$url answered 200, status \"$(jq -r .status "$work/product.body")\""
  fi
}

check_incidents() {
  url="$api/api/v1/incidents"
  if ! fetch incidents "$url"; then
    fail incidents "$url $fetch_error"
    return
  fi
  if [ "$code" != 200 ]; then
    fail incidents "$url answered HTTP $code, want 200$(why incidents)"
    return
  fi
  generated=$(generated_at incidents)
  if ! jq -e 'type == "object"' "$work/incidents.body" >/dev/null 2>&1; then
    fail incidents "$url answered 200 but the body is not a JSON object"
  elif [ -z "$generated" ]; then
    fail incidents "$url answered 200 but the body has no generated_at"
  elif ! age=$(age_of "$generated") || [ -z "$age" ]; then
    fail incidents "$url generated_at \"$generated\" is not an RFC 3339 UTC time"
  elif [ "$age" -gt "$max_age" ]; then
    fail incidents "$url generated_at $generated is ${age}s old, limit ${max_age}s"
  else
    pass incidents "$url answered 200, generated_at $generated is ${age}s old"
  fi
}

# check_deep_link fetches the page of the product check_product fetched and
# the incident history page, the links the page's shell must answer.
check_deep_link() {
  urls="$base/history"
  [ -n "$id" ] && urls="$base/products/$id $urls"
  for url in $urls; do
    if ! fetch deeplink "$url"; then
      fail deep-link "$url $fetch_error"
      return
    elif [ "$code" != 200 ]; then
      fail deep-link "$url answered HTTP $code, want 200$(why deeplink)"
      return
    elif ! grep -q 'id="root"' "$work/deeplink.body"; then
      fail deep-link "$url answered 200 but the HTML has no app root (id=\"root\")"
      return
    fi
  done
  pass deep-link "$(echo "$urls" | sed 's/ / and /') answered 200 with the app root"
}

echo "synthetic check of $base (API $api), request ids $rid-*"
check_page
check_assets
check_summary
describe
check_product
check_incidents
check_deep_link

if [ "$failed" -gt 0 ]; then
  echo "synthetic check: $failed failed, $skipped skipped, $passed passed"
  exit 1
fi
echo "synthetic check: all $passed passed"
