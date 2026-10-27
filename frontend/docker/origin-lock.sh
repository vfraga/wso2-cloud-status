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

# Writes /tmp/origin.conf, which docker/nginx.conf includes, from the
# environment before nginx starts. A wrong setting stops the container.
#
#   FRONT_DOOR_ID  the Azure Front Door profile's ID. Every request but the
#                  health probe must carry it in X-Azure-FDID, or it gets 403:
#                  the page is reachable only through this profile, behind its
#                  WAF and cache, as statusd is (its origin lock). Required
#                  unless ORIGIN_LOCK=off.
#   ORIGIN_LOCK    on (default) or off. Off answers requests that did not come
#                  through Front Door: local runs and the Choreo demo only.
#   INDEXING       on (default) or off. Off sends X-Robots-Tag: noindex, for
#                  staging and the demo, so search engines list only
#                  production.
set -eu

case "${ORIGIN_LOCK:-on}" in
  on)
    id="${FRONT_DOOR_ID:-}"
    case "$id" in
      "")
        echo "$0: FRONT_DOOR_ID is not set (set ORIGIN_LOCK=off only outside production)" >&2
        exit 1
        ;;
      *[!0-9A-Za-z-]*)
        echo "$0: FRONT_DOOR_ID may hold only letters, digits and hyphens" >&2
        exit 1
        ;;
    esac
    refused="map \$http_x_azure_fdid \$origin_refused { \"$id\" 0; default 1; }"
    echo "$0: origin lock on: requests without this Front Door profile's X-Azure-FDID get 403"
    ;;
  off)
    refused="map \$http_x_azure_fdid \$origin_refused { default 0; }"
    echo "$0: origin lock off: the page answers requests that did not come through Front Door" >&2
    ;;
  *)
    echo "$0: ORIGIN_LOCK must be on or off, not \"$ORIGIN_LOCK\"" >&2
    exit 1
    ;;
esac

case "${INDEXING:-on}" in
  on) robots="map \$http_x_azure_fdid \$robots_tag { default \"\"; }" ;;
  off) robots="map \$http_x_azure_fdid \$robots_tag { default \"noindex\"; }" ;;
  *)
    echo "$0: INDEXING must be on or off, not \"$INDEXING\"" >&2
    exit 1
    ;;
esac

printf '%s\n%s\n' "$refused" "$robots" >/tmp/origin.conf
