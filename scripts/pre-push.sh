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

# Git pre-push hook (make hooks installs it): runs the quick local gates for
# what the pushed commits change, so a push does not wait for CI to find a
# lint or unit test failure. Both unit test suites run for any change but
# Markdown, because tests read files outside their own folder (the
# configuration, the alert rules, test data, the API document); lint, type
# and image checks run for the folders they cover. CI still runs every gate;
# make verify runs them all here. It checks the working tree, so commit or
# stash other changes first. git push --no-verify skips the hook.
set -euo pipefail
cd "$(dirname "$(readlink -f "$0")")/.."

# Git sends one line per ref: <local ref> <local sha> <remote ref> <remote sha>.
changed=""
while read -r _ local_sha _ remote_sha; do
  [[ $local_sha =~ ^0+$ ]] && continue # a deleted ref
  base=$remote_sha
  if [[ $base =~ ^0+$ ]] || ! git cat-file -e "$base^{commit}" 2>/dev/null; then
    # A new branch, or a remote commit not fetched: compare with main.
    base=$(git merge-base "$local_sha" origin/main 2>/dev/null) || base=$(git rev-list --max-parents=0 "$local_sha" | tail -n 1)
  fi
  changed+=$(git diff --name-only --relative "$base" "$local_sha")$'\n'
done
touches() { grep -qE "$1" <<<"$changed"; }

# Anything but Markdown: both unit test suites.
grep -qvE '^$|\.md$' <<<"$changed" || exit 0
gates=(test)
touches '^(backend/go|tests/contract)/' && gates+=(lint)
touches '^config/' && gates+=(check-config)
touches '^deploy/observability/' && gates+=(rules)
touches '\.sh$' && gates+=(shellcheck)
touches '\.(go|sh|ts|tsx|js|mjs)$' && gates+=(headers)
touches '^\.github/workflows/' && gates+=(workflow-lint)
touches '(^|/)Dockerfile$' && gates+=(dockerfile-lint)
touches '^api/openapi\.yaml$|^\.spectral\.yaml$' && gates+=(api-lint)
touches '^(\.github/workflows/|Makefile$|backend/go/go\.mod$|frontend/\.nvmrc$)|(^|/)Dockerfile$' && gates+=(pins)
frontend_static=false
touches '^frontend/' && frontend_static=true

echo "pre-push: make ${gates[*]}, frontend unit tests$([[ $frontend_static == true ]] && echo ', lint and types')"
make "${gates[@]}"
# The Node that .nvmrc names, when nvm has it.
node_bin="${NVM_DIR:-$HOME/.nvm}/versions/node/v$(tr -d '[:space:]' <frontend/.nvmrc)/bin"
[[ -d $node_bin ]] && PATH="$node_bin:$PATH"
cd frontend
if [[ $frontend_static == true ]]; then
  npm run --silent lint
  npm run --silent typecheck
fi
npm test --silent
