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

# Grype's vulnerability report, a second opinion next to Trivy: another
# matcher and severity source, and it also reads npm development
# dependencies and the pinned GitHub Actions. It informs and never fails on a
# finding; Trivy is the gate. It fails only when Grype itself cannot run, so
# a missing report shows (CI runs it with continue-on-error).
#
#   GRYPE_IMAGE=<pinned image> scripts/grype-report.sh repo
#   GRYPE_IMAGE=<pinned image> scripts/grype-report.sh <local image>
#
# "repo" is the committed tree (git archive HEAD). The target is copied into
# Grype's container rather than mounted, so it runs the same under act. The
# table goes to stdout and, in GitHub Actions, to the job summary.
set -euo pipefail

target="${1:?usage: grype-report.sh repo | <local image>}"
grype="${GRYPE_IMAGE:?set GRYPE_IMAGE to the image pinned in .github/workflows/ci.yml}"
root="$(cd "$(dirname "$0")/.." && pwd)"
work="$(mktemp -d)"
id=""
# shellcheck disable=SC2329 # called by the EXIT trap
cleanup() {
  [[ -n "$id" ]] && docker rm -f "$id" >/dev/null 2>&1
  rm -rf "$work"
}
trap cleanup EXIT

if [[ "$target" == repo ]]; then
  git -C "$root" archive --prefix=scan/repo/ HEAD >"$work/in.tar"
  source="dir:/scan/repo"
else
  mkdir "$work/scan"
  docker save -o "$work/scan/image.tar" "$target"
  tar --no-xattrs -cf "$work/in.tar" -C "$work" scan
  source="docker-archive:/scan/image.tar"
fi
id="$(docker create "$grype" "$source" -o table -q)"
docker cp - "$id:/" <"$work/in.tar"
docker start -a "$id" | tee "$work/report.txt"

if [[ -n "${GITHUB_STEP_SUMMARY:-}" ]]; then
  {
    echo "### Grype report: $target (informs, never fails)"
    echo '```text'
    cat "$work/report.txt"
    echo '```'
  } >>"$GITHUB_STEP_SUMMARY"
fi
