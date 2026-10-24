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

# Self-test of the frontend image: runs it and checks the status, caching and
# security headers that frontend/docker/nginx.conf sets.
#
#   scripts/ops/frontend-image-selftest.sh [IMAGE]   (or: make web-docker-selftest)
#
# Without IMAGE it builds frontend/Dockerfile as wso2-cloud-status-web:selftest.
# Expects:
#   /                     200 HTML with the app root, Cache-Control no-cache
#   /products/<id>        200, the same HTML (deep links are served by the shell)
#   each module script and stylesheet index.html references
#                         200, a JavaScript or CSS type, cached for a year
#                         (immutable), gzip on request from the file the
#                         build compressed; 304 on revalidation, still
#                         immutable
#   a missing asset       404 with no-store: a cached 404 for a bundle a deploy
#                         has not reached yet leaves the page blank
#   /api/x                404 with no-store, not the HTML shell; with
#                         /etc/nginx/api.conf replaced, that file answers it
#   /healthz              200 "ok", no-store
#   /.well-known/security.txt
#                         200 text/plain; charset=utf-8 (RFC 9116) with
#                         Contact, Policy and an Expires in the coming year
#   the security headers (CSP, nosniff, Referrer-Policy, X-Frame-Options, COOP,
#   Permissions-Policy, Strict-Transport-Security) on every page, asset, 404
#   and security.txt; no nginx version in Server
#   the page and assets lines of scripts/ops/synthetic-check.sh pass against it
#   the image runs as user 10001, carries the OCI version, revision and source
#   labels, and its HEALTHCHECK reports healthy
# Stops the containers it started. Needs docker and curl. Ports
# FRONTEND_SELFTEST_PORT and the next one, default 18790 and 18791.
set -euo pipefail

root="$(cd "$(dirname "$0")/../.." && pwd)"
image="${1:-}"
port="${FRONTEND_SELFTEST_PORT:-18790}"
name="frontend-selftest-$$"
work="$(mktemp -d)"
failures=0
passes=0

cleanup() {
  docker rm -f "$name" "$name-api" >/dev/null 2>&1 || true
  rm -rf "$work"
}
trap cleanup EXIT

for p in "$port" "$((port + 1))"; do
  if (exec 3<>"/dev/tcp/127.0.0.1/$p") 2>/dev/null; then
    echo "selftest: port $p is already in use; set FRONTEND_SELFTEST_PORT" >&2
    exit 2
  fi
done

if [[ -z "$image" ]]; then
  image=wso2-cloud-status-web:selftest
  echo "Building $image from frontend/Dockerfile"
  docker build -q -t "$image" "$root/frontend" >/dev/null
fi

ok() {
  passes=$((passes + 1))
  printf 'PASS %s\n' "$1"
}

bad() {
  failures=$((failures + 1))
  printf 'FAIL %s\n' "$1"
}

# verdict PASS_TEXT FAIL_TEXT COMMAND...: PASS or FAIL by the command's status.
verdict() {
  local yes="$1" no="$2"
  shift 2
  if "$@"; then ok "$yes"; else bad "$no"; fi
}

# get NAME PATH [curl options]: fetches PATH into $work/NAME.{body,headers}
# and sets code.
get() {
  local id="$1" path="$2"
  shift 2
  code=$(curl -sS --max-time 10 -o "$work/$id.body" -D "$work/$id.headers" -w '%{http_code}' "$@" \
    "http://127.0.0.1:${port}${path}")
}

# hdr NAME FIELD prints response header FIELD of fetch NAME.
hdr() {
  tr -d '\r' <"$work/$1.headers" | awk -v field="$2" '
    index($0, ":") > 0 && tolower(substr($0, 1, index($0, ":") - 1)) == tolower(field) {
      value = substr($0, index($0, ":") + 1); sub(/^[ \t]+/, "", value)
    }
    END { print value }'
}

# expect NAME WHAT CODE CACHE: checks the status and the exact Cache-Control.
expect() {
  local id="$1" what="$2" want_code="$3" want_cache="$4" cache
  cache="$(hdr "$id" Cache-Control)"
  if [[ "$code" != "$want_code" ]]; then
    bad "$what answered $code, want $want_code"
  elif [[ "$cache" != "$want_cache" ]]; then
    bad "$what Cache-Control is \"$cache\", want \"$want_cache\""
  else
    ok "$what answered $code with Cache-Control \"$cache\""
  fi
}

# security NAME WHAT: the headers security-headers.conf adds.
security() {
  local id="$1" what="$2" absent=() csp
  csp="$(hdr "$id" Content-Security-Policy)"
  for directive in "default-src 'none'" "script-src 'self'" "connect-src 'self'" "frame-ancestors 'none'"; do
    [[ "$csp" == *"$directive"* ]] || absent+=("CSP $directive")
  done
  [[ "$(hdr "$id" X-Content-Type-Options)" == nosniff ]] || absent+=("X-Content-Type-Options nosniff")
  [[ "$(hdr "$id" Referrer-Policy)" == no-referrer ]] || absent+=("Referrer-Policy no-referrer")
  [[ "$(hdr "$id" X-Frame-Options)" == DENY ]] || absent+=("X-Frame-Options DENY")
  [[ "$(hdr "$id" Cross-Origin-Opener-Policy)" == same-origin ]] || absent+=("Cross-Origin-Opener-Policy same-origin")
  [[ -n "$(hdr "$id" Permissions-Policy)" ]] || absent+=("Permissions-Policy")
  [[ "$(hdr "$id" Strict-Transport-Security)" == "max-age=31536000" ]] ||
    absent+=("Strict-Transport-Security max-age=31536000")
  [[ "$(hdr "$id" Server)" != *[0-9]* ]] || absent+=("Server without a version")
  if [[ ${#absent[@]} -eq 0 ]]; then
    ok "$what carries the security headers"
  else
    bad "$what lacks: $(printf '%s; ' "${absent[@]}")"
  fi
}

echo "Starting $image on 127.0.0.1:$port"
# A short health interval so Docker runs the image's HEALTHCHECK command soon.
docker run -d --name "$name" -p "127.0.0.1:${port}:8080" --health-interval 2s "$image" >/dev/null
up=false
for _ in $(seq 1 100); do
  curl -fsS -o /dev/null "http://127.0.0.1:${port}/healthz" 2>/dev/null && up=true && break
  sleep 0.2
done
if [[ "$up" != true ]]; then
  echo "selftest: the container never answered /healthz" >&2
  docker logs "$name" 2>&1 | tail -n 20 >&2
  exit 1
fi

get healthz /healthz
expect healthz "/healthz" 200 "no-store"
verdict "/healthz says ok" "/healthz body is not ok" [ "$(cat "$work/healthz.body")" = ok ]

get page /
expect page "/" 200 "no-cache"
security page "/"
if [[ "$(hdr page Content-Type)" == text/html* ]] && grep -q 'id="root"' "$work/page.body"; then
  ok "/ is the HTML shell with the app root"
else
  bad "/ is not the HTML shell with the app root"
fi

get deep /products/moesif
expect deep "/products/moesif" 200 "no-cache"
verdict "/products/moesif is the same shell" "/products/moesif differs from /" cmp -s "$work/page.body" "$work/deep.body"

# The assets the shell loads: module scripts, module preloads, stylesheets.
assets=()
while IFS= read -r asset; do
  assets+=("$asset")
done < <(tr '\r\n' '  ' <"$work/page.body" | grep -oE '<(script|link)[[:space:]][^>]*>' |
  grep -E 'type="module"|rel="(modulepreload|stylesheet)"' | sed -nE 's/.*[[:space:]](src|href)="(\/assets\/[^"]+)".*/\2/p')
immutable="public, max-age=31536000, immutable"
if [[ ${#assets[@]} -eq 0 ]]; then
  bad "index.html references no module script or stylesheet under /assets/"
else
  i=0
  for asset in "${assets[@]}"; do
    i=$((i + 1))
    get "asset$i" "$asset"
    expect "asset$i" "$asset" 200 "$immutable"
    type="$(hdr "asset$i" Content-Type)"
    case "$asset:$type" in
      *.js:application/javascript* | *.js:text/javascript* | *.css:text/css*) ok "$asset is served as $type" ;;
      *) bad "$asset is served as \"$type\"" ;;
    esac
  done
  first="${assets[0]}"
  security asset1 "$first"
  get gzip "$first" -H 'Accept-Encoding: gzip'
  gzipped=false
  [[ "$(hdr gzip Content-Encoding)" == gzip && "$(hdr gzip Vary)" == *Accept-Encoding* ]] && gzipped=true
  verdict "$first is gzipped on request, with Vary: Accept-Encoding" \
    "$first is not gzipped on request, or lacks Vary: Accept-Encoding" "$gzipped"
  # Compressing on the fly sends no Content-Length and weakens the ETag; the
  # file the build compressed has both, and holds the same bytes.
  static=false
  [[ -n "$(hdr gzip Content-Length)" && "$(hdr gzip ETag)" != W/* ]] &&
    gzip -dc <"$work/gzip.body" | cmp -s - "$work/asset1.body" && static=true
  verdict "$first is sent from the file the build compressed" \
    "$first is compressed on the fly, or its .gz copy differs from the file" "$static"
  get revalidate "$first" -H "If-None-Match: $(hdr asset1 ETag)"
  expect revalidate "$first revalidated (If-None-Match)" 304 "$immutable"
fi

# The icons the shell links sit at the root, outside /assets: each must be the
# file itself, never the HTML shell that try_files falls back to.
icons=()
while IFS= read -r icon; do
  icons+=("$icon")
done < <(tr '\r\n' '  ' <"$work/page.body" | grep -oE '<link[[:space:]][^>]*>' |
  grep -E 'rel="(icon|apple-touch-icon)"' | sed -nE 's/.*[[:space:]]href="(\/[^"]+)".*/\1/p')
if [[ ${#icons[@]} -lt 3 ]]; then
  bad "index.html links ${#icons[@]} icons, want favicon.ico, icon.svg and apple-touch-icon.png"
else
  i=0
  for icon in "${icons[@]}"; do
    i=$((i + 1))
    get "icon$i" "$icon"
    expect "icon$i" "$icon" 200 "no-cache"
    type="$(hdr "icon$i" Content-Type)"
    case "$icon:$type" in
      *.ico:image/x-icon | *.svg:image/svg+xml | *.png:image/png) ok "$icon is served as $type" ;;
      *) bad "$icon is served as \"$type\"" ;;
    esac
  done
fi

missing="/assets/index-selftest-missing-$$.js"
get missing "$missing"
expect missing "missing asset $missing" 404 "no-store"
security missing "missing asset"

get api /api/x
expect api "/api/x" 404 "no-store"
security api "/api/x"
shell_html=false
grep -q 'id="root"' "$work/api.body" && shell_html=true
verdict "/api/x is not the HTML shell" "/api/x answered with the HTML shell" [ "$shell_html" = false ]

get securitytxt /.well-known/security.txt
expect securitytxt "/.well-known/security.txt" 200 "public, max-age=3600"
security securitytxt "/.well-known/security.txt"
verdict "/.well-known/security.txt is text/plain; charset=utf-8" \
  "/.well-known/security.txt is \"$(hdr securitytxt Content-Type)\", want text/plain; charset=utf-8" \
  [ "$(hdr securitytxt Content-Type)" = "text/plain; charset=utf-8" ]
missing_fields=()
grep -Eq '^Contact: mailto:[^ ]+@[^ ]+$' "$work/securitytxt.body" || missing_fields+=("Contact: mailto:")
grep -Eq '^Policy: https://[^ ]+$' "$work/securitytxt.body" || missing_fields+=("Policy: https://")
expires="$(sed -nE 's/^Expires: (.*)$/\1/p' "$work/securitytxt.body")"
left="$(jq -nr --arg t "$expires" '($t | fromdateiso8601) - now | floor' 2>/dev/null || true)"
# RFC 9116 wants Expires in the future and, recommended, less than a year
# ahead; the build sets it a year after the commit time.
if [[ ! "$left" =~ ^[0-9]+$ || "$left" -gt $((366 * 86400)) ]]; then
  missing_fields+=("Expires in the coming year (got \"$expires\")")
fi
if [[ ${#missing_fields[@]} -eq 0 ]]; then
  ok "/.well-known/security.txt has Contact, Policy and Expires ($expires)"
else
  bad "/.well-known/security.txt lacks: $(printf '%s; ' "${missing_fields[@]}")"
fi

# The external check's page and asset lines against the real build. Its API
# checks fail here (nginx does not serve /api), so only those two lines count.
STATUS_BASE_URL="http://127.0.0.1:${port}" sh "$root/scripts/ops/synthetic-check.sh" >"$work/synthetic.out" 2>&1 || true
for check in page assets; do
  if grep -Eq "^PASS $check " "$work/synthetic.out"; then
    ok "synthetic-check.sh $check passes against the image"
  else
    bad "synthetic-check.sh $check does not pass against the image:"
    cat "$work/synthetic.out"
  fi
done

user="$(docker inspect --format '{{.Config.User}}' "$image")"
verdict "the image runs as user 10001" "the image runs as user \"$user\", want 10001" [ "$user" = 10001 ]
labels=()
for label in version revision source; do
  value="$(docker inspect --format "{{index .Config.Labels \"org.opencontainers.image.$label\"}}" "$image")"
  [[ -n "$value" ]] || labels+=("org.opencontainers.image.$label")
done
verdict "the image carries the OCI version, revision and source labels" \
  "the image lacks the labels: ${labels[*]:-}" [ "${#labels[@]}" -eq 0 ]

health=""
for _ in $(seq 1 30); do
  health="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{end}}' "$name")"
  [[ "$health" == starting ]] || break
  sleep 1
done
verdict "Docker HEALTHCHECK reports healthy" "Docker HEALTHCHECK reports \"$health\", want healthy" [ "$health" = healthy ]

# A deployment with nothing in front of the page to route /api (the Choreo
# demo) replaces /etc/nginx/api.conf. The file is copied in rather than
# mounted, so this runs the same under act.
mkdir "$work/api"
printf 'location /api/ {\n    return 200 "replaced\\n";\n}\n' >"$work/api/api.conf"
docker create --name "$name-api" -p "127.0.0.1:$((port + 1)):8080" "$image" >/dev/null
tar --no-xattrs -cf - -C "$work/api" api.conf | docker cp - "$name-api:/etc/nginx/"
docker start "$name-api" >/dev/null
replaced=""
for _ in $(seq 1 50); do
  replaced="$(curl -fsS --max-time 2 "http://127.0.0.1:$((port + 1))/api/x" 2>/dev/null)" && break
  sleep 0.2
done
verdict "a replaced /etc/nginx/api.conf answers /api/" \
  "a replaced /etc/nginx/api.conf does not answer /api/ (got \"$replaced\")" [ "$replaced" = replaced ]

echo
if [[ "$failures" -gt 0 ]]; then
  echo "selftest: $failures check(s) failed, $passes passed" >&2
  docker logs "$name" 2>&1 | tail -n 20 >&2
  exit 1
fi
echo "selftest: all $passes checks passed"
