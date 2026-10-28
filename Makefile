# Developer entry points. make ci is CI's go job; the Docker targets (rules,
# dockerfile-lint, shellcheck, api-lint, headers, workflow-lint,
# web-docker-selftest) and the web-* targets cover its other jobs. Only CI
# runs gitleaks, Trivy and the statusd image build and smoke test; run its
# compliance and container jobs under act.
SHELL := /bin/bash
.SHELLFLAGS := -euo pipefail -c

GO_DIR       := backend/go
# CI's minimum (ci.yml), unless set on the command line.
COVERAGE_MIN ?= $(shell sed -nE 's/^  COVERAGE_MIN: "?([0-9]+)"?$$/\1/p' .github/workflows/ci.yml)
GOVULNCHECK  := golang.org/x/vuln/cmd/govulncheck@v1.9.0
GOLICENSES   := github.com/google/go-licenses/v2@v2.0.1
LICENSES_OK  := Apache-2.0,MIT,BSD-2-Clause,BSD-3-Clause,ISC
PROMETHEUS   := prom/prometheus:v3.15.1@sha256:fa3302279710be2f21a8301ec17a8b4f2301fd829bd113839b3b6b02b6f191a2
# The hadolint that hadolint/hadolint-action HADOLINT_ACTION (ci.yml) runs.
HADOLINT_ACTION := v3.5.0
HADOLINT     := ghcr.io/hadolint/hadolint:v2.15.1-debian@sha256:9a3944b7fddcb947d1ffd90829ac1a6e5c30479223358f249d8b96c7d0019e27
SHELLCHECK   := koalaman/shellcheck:v0.11.0@sha256:61862eba1fcf09a484ebcc6feea46f1782532571a34ed51fedf90dd25f925a8d
SPECTRAL     := stoplight/spectral:6.17.0@sha256:c8ffae6ee561b70e80402f1ea669e8b37c74fee48a3dbe2147b71359ed987239
# The SkyWalking Eyes release that apache/skywalking-eyes/header (ci.yml) builds
# from source; make pins checks the two name the same version.
LICENSE_EYE  := apache/skywalking-eyes:0.9.0@sha256:cd89ccbbcba2e87d3fb0e34b156b1da208d6c5ac1ada4e2d335e920022c765b8
ACTIONLINT   := rhysd/actionlint:1.7.12@sha256:b1934ee5f1c509618f2508e6eb47ee0d3520686341fec936f3b79331f9315667
# Releases are tagged v<semver> (v0.1.0); other tags never name a build.
# Without a v tag the version is the commit id.
VERSION      ?= $(shell git describe --tags --match 'v*' --always --dirty 2>/dev/null || echo dev)
REVISION     ?= $(shell git rev-parse HEAD 2>/dev/null || echo unknown)
CREATED      ?= $(shell TZ=UTC0 git log -1 --date=format-local:%Y-%m-%dT%H:%M:%SZ --format=%cd 2>/dev/null)
SOURCE       ?= https://github.com/wso2/wso2-cloud-status
IMAGE        ?= wso2-cloud-statusd:$(VERSION)
IMAGE_ARGS   := --build-arg VERSION=$(VERSION) --build-arg REVISION=$(REVISION) --build-arg CREATED=$(CREATED) --build-arg SOURCE=$(SOURCE)
# Every ${NAME} the files in config/ use, set to a placeholder for check-config.
CHECK_CONFIG_ENV ?= FRONT_DOOR_ID=00000000-0000-0000-0000-000000000000
# Tracked scripts; outside a git checkout (an export), every script but dependencies.
SHELL_SCRIPTS = $(shell git ls-files '*.sh' 2>/dev/null || find . -name '*.sh' -not -path '*/node_modules/*' | sort)

.DEFAULT_GOAL := help
.PHONY: help fmt lint test cover vuln licenses rules contract contract-edge contract-csm check-config live build run docker ci clean \
	web-install web-check web-licenses web-e2e web-docker web-docker-selftest dockerfile-lint shellcheck api-lint \
	headers workflow-lint workflow-cache pins gates-selftest verify \
	synthetic synthetic-selftest

help: ## List targets
	@awk 'BEGIN { FS = ":.*## " } /^[a-zA-Z0-9_-]+:.*## / { printf "  %-20s %s\n", $$1, $$2 }' $(MAKEFILE_LIST)

fmt: ## Format Go code (gofumpt, goimports), backend and contract tests
	cd $(GO_DIR) && golangci-lint fmt ./...
	cd tests/contract && golangci-lint fmt --config ../../$(GO_DIR)/.golangci.yml ./...

lint: ## Lint backend and contract tests: vet, staticcheck, gosec, complexity, license headers
	@want="$$(sed -nE 's/^  GOLANGCI_LINT_VERSION: v?//p' .github/workflows/ci.yml)"; have="$$(golangci-lint version --short)"; \
	  [[ -n "$$want" && "$$have" == "$$want" ]] || { echo "golangci-lint $$have here, ci.yml runs $${want:-?}"; exit 1; }
	cd $(GO_DIR) && golangci-lint run ./...
	cd tests/contract && golangci-lint run --config ../../$(GO_DIR)/.golangci.yml ./...

test: ## Unit and integration tests with the race detector
	cd $(GO_DIR) && go test -race -count=1 ./...

cover: ## Tests plus the coverage gate (COVERAGE_MIN)
	cd $(GO_DIR) && go test -race -count=1 -covermode=atomic -coverprofile=coverage.out ./...
	cd $(GO_DIR) && ../../scripts/coverage-gate.sh coverage.out $(COVERAGE_MIN)

vuln: ## Known-vulnerability scan of reachable code
	cd $(GO_DIR) && go run $(GOVULNCHECK) ./...

licenses: ## Licence allow-list for every Go package compiled in
	cd $(GO_DIR) && go run $(GOLICENSES) check ./... --ignore github.com/wso2/wso2-cloud-status --allowed_licenses=$(LICENSES_OK)

rules: ## Validate and unit-test the Prometheus alert rules (Docker)
	docker run --rm --entrypoint promtool -v "$$PWD/deploy/observability:/r:ro" -w /r $(PROMETHEUS) check rules prometheus-rules.yaml
	docker run --rm --entrypoint promtool -v "$$PWD/deploy/observability:/r:ro" -w /r $(PROMETHEUS) test rules prometheus-rules.test.yaml

contract: build ## Contract tests against the Go backend
	scripts/contract.sh ./bin/statusd

contract-edge: build ## Contract tests against the Go backend, edge-case upstream data
	CONTRACT_SCENARIO=edge scripts/contract.sh ./bin/statusd

contract-csm: build ## Contract tests with every backend read through the CSM adapter
	CONTRACT_SOURCE=csm scripts/contract.sh ./bin/statusd

check-config: build ## Validate every file in config/ as a start would (statusd -check-config)
	for f in config/*.yaml; do env $(CHECK_CONFIG_ENV) ./bin/statusd -check-config "$$f"; done

synthetic: ## External check of a deployed page and API (SYNTHETIC_BASE_URL=https://...)
	scripts/ops/synthetic-check.sh "$(SYNTHETIC_BASE_URL)"

synthetic-selftest: ## The external check against a local statusd, passing and failing cases
	scripts/ops/synthetic-selftest.sh

gates-selftest: ## The licence and coverage gate scripts with inputs that must pass and must fail
	scripts/gates-selftest.sh

live: ## Smoke test against the real public status APIs (network)
	cd $(GO_DIR) && go test -tags live -count=1 -run Live ./internal/app/

build: ## Build bin/statusd
	cd $(GO_DIR) && CGO_ENABLED=0 go build -trimpath -ldflags "-s -w -X main.version=$(VERSION)" -o ../../bin/statusd ./cmd/statusd

run: build ## Run against the real upstream APIs
	./bin/statusd -config config/statusd.yaml

docker: ## Build the statusd image, with the version and OCI labels
	docker build -f $(GO_DIR)/Dockerfile $(IMAGE_ARGS) -t $(IMAGE) .

web-install: ## Frontend dependencies (Node per frontend/.nvmrc)
	cd frontend && npm ci

web-check: ## Frontend lint, types, tests with coverage, build, audit
	cd frontend && npm run lint && npm run typecheck && npm test && npm run build && npm audit --audit-level=high

web-licenses: ## Licence allow-list for the npm packages the frontend ships (needs jq)
	scripts/npm-licenses.sh frontend/package-lock.json

web-e2e: ## Frontend end-to-end tests against the real backend (Playwright)
	cd frontend && npm run e2e

web-docker: ## Frontend container image, with the OCI labels
	docker build $(IMAGE_ARGS) -t wso2-cloud-status-web:$(VERSION) frontend

web-docker-selftest: ## Build the frontend image, run it and check its caching and security headers (Docker)
	scripts/ops/frontend-image-selftest.sh

dockerfile-lint: ## hadolint both Dockerfiles, the version CI runs (Docker)
	for f in $(GO_DIR)/Dockerfile frontend/Dockerfile; do echo "$$f"; docker run --rm -i $(HADOLINT) hadolint - <"$$f"; done

shellcheck: ## shellcheck every tracked shell script, the version CI runs (Docker)
	docker run --rm -v "$$PWD:/mnt:ro" -w /mnt $(SHELLCHECK) $(SHELL_SCRIPTS)

api-lint: ## Lint api/openapi.yaml with Spectral and .spectral.yaml, as CI does (Docker)
	docker run --rm --platform linux/amd64 -v "$$PWD:/w:ro" -w /w $(SPECTRAL) lint api/openapi.yaml --ruleset .spectral.yaml

headers: ## License headers on every source file, the check CI runs (Docker)
	docker run --rm -v "$$PWD:/github/workspace:ro" -w /github/workspace $(LICENSE_EYE) header check

workflow-lint: ## Lint the GitHub workflows with actionlint, as CI does (Docker)
	docker run --rm -v "$$PWD:/repo:ro" -w /repo $(ACTIONLINT) -color

# A job that holds secrets or id-token: write, itself or through the
# workflow's own permissions or env, must not restore an Actions cache, which
# any job on main can write. The actions in the middle of the list cache
# unless the step turns it off, actions/cache always does, and those in
# nocache never do; any other action in such a job fails the check until it
# is listed.
workflow-cache: ## No workflow job with secrets or id-token: write uses an action with its cache on
	@awk ' \
	  BEGIN { \
	    nocache = "^(actions/(checkout|upload-artifact|download-artifact|attest|dependency-review-action)" \
	      "|docker/(login-action|setup-buildx-action)|sigstore/cosign-installer|github/codeql-action/[a-z-]+" \
	      "|apache/skywalking-eyes/header|hadolint/hadolint-action)$$"; \
	  } \
	  function end_step(  on) { \
	    if (action == "") return; \
	    if (action ~ /^actions\/cache(\/|$$)/) on = 1; \
	    else if (action == "aquasecurity/trivy-action" || action == "actions/setup-go") on = w["cache"] != "false"; \
	    else if (action == "actions/setup-node") on = w["package-manager-cache"] != "false" || w["cache"] != ""; \
	    else if (action == "golangci/golangci-lint-action") on = w["skip-cache"] != "true"; \
	    else if (action == "docker/build-push-action") on = w["cache-from"] != ""; \
	    else if (action !~ nocache) found = found FILENAME ": job " job " uses " action ", not known to keep off the cache\n"; \
	    if (on) found = found FILENAME ": job " job " uses " action " with its cache on\n"; \
	    action = ""; inwith = 0; split("", w); \
	  } \
	  function end_job() { \
	    end_step(); \
	    if ((privileged || wprivileged) && found != "") { printf "%s", found; bad = 1 } \
	    job = ""; privileged = 0; found = ""; \
	  } \
	  FNR == 1 { end_job(); injobs = 0; wprivileged = 0 } \
	  { line = $$0; sub(/[ \t]+#.*$$/, "", line) } \
	  !injobs && line ~ /secrets\.|secrets: *inherit|id-token: *write/ { wprivileged = 1 } \
	  line ~ /^jobs:/ { injobs = 1; next } \
	  line ~ /^[^ ]/ { end_job(); injobs = 0; next } \
	  !injobs { next } \
	  line ~ /^  [^ ]/ { end_job(); job = line; sub(/^ +/, "", job); sub(/:.*/, "", job); next } \
	  line ~ /secrets\.|secrets: *inherit|id-token: *write/ { privileged = 1 } \
	  line ~ /^      - / { end_step() } \
	  line ~ /^      (- |  )uses:/ { action = line; sub(/^ *(- )?uses: */, "", action); sub(/@.*/, "", action); next } \
	  line ~ /^      (- |  )with:/ { inwith = 1; next } \
	  line ~ /^        [^ ]/ { inwith = 0 } \
	  inwith && line ~ /^          [a-z-]+:/ { \
	    key = line; sub(/^ +/, "", key); sub(/:.*/, "", key); \
	    value = line; sub(/^ *[a-z-]+: */, "", value); gsub(/["\047]/, "", value); w[key] = value; \
	  } \
	  END { \
	    end_job(); \
	    if (bad) exit 1; \
	    print "no job with secrets or id-token: write uses an action with its cache on"; \
	  }' .github/workflows/*.yml

pins: workflow-cache ## The tool versions copied from ci.yml, here and in release.yml, still match it; the Dockerfiles build with go.mod's Go and .nvmrc's Node; no privileged job uses a cache
	@status=0; \
	for pin in '$(GOVULNCHECK)' '$(GOLICENSES)' '$(LICENSES_OK)' '$(PROMETHEUS)' '$(SHELLCHECK)' '$(SPECTRAL)' '$(ACTIONLINT)'; do \
	  awk -v p=": $$pin" 'substr($$0, length($$0) - length(p) + 1) == p { found = 1 } END { exit !found }' .github/workflows/ci.yml \
	    || { echo "Makefile pin not in ci.yml: $$pin"; status=1; }; \
	done; \
	found=0; \
	while IFS= read -r line; do \
	  found=$$((found + 1)); \
	  grep -qxF -- "$$line" .github/workflows/ci.yml || { echo "release.yml pin not in ci.yml: $$line"; status=1; }; \
	done < <(grep -E '^  (TRIVY_VERSION|BUILDKIT_IMAGE):' .github/workflows/release.yml); \
	[[ $$found == 2 ]] || { echo "release.yml has $$found of its two pins (TRIVY_VERSION, BUILDKIT_IMAGE)"; status=1; }; \
	eye='$(LICENSE_EYE)'; eye="$${eye#*:}"; eye="$${eye%%@*}"; \
	eye_uses="$$(grep -E 'uses: apache/skywalking-eyes/header@' .github/workflows/ci.yml || true)"; \
	[[ -n "$$eye_uses" ]] && ! grep -vqE " # v$${eye}"'$$' <<<"$$eye_uses" \
	  || { echo "ci.yml runs a skywalking-eyes/header other than v$$eye, the release LICENSE_EYE copies"; status=1; }; \
	go_version="$$(awk '$$1 == "go" { print $$2 }' backend/go/go.mod)"; \
	[[ "$$(awk '$$1 == "go" { print $$2 }' tests/contract/go.mod)" == "$$go_version" ]] \
	  || { echo "tests/contract/go.mod is not on Go $$go_version like backend/go/go.mod"; status=1; }; \
	grep -qF "FROM golang:$$go_version-" backend/go/Dockerfile \
	  || { echo "backend/go/Dockerfile does not build with Go $$go_version (backend/go/go.mod)"; status=1; }; \
	node_version="$$(tr -d '[:space:]' <frontend/.nvmrc)"; \
	grep -qF "FROM node:$$node_version-" frontend/Dockerfile \
	  || { echo "frontend/Dockerfile does not build with Node $$node_version (frontend/.nvmrc)"; status=1; }; \
	hadolint_uses="$$(grep -E 'uses: hadolint/hadolint-action@' .github/workflows/ci.yml || true)"; \
	[[ -n "$$hadolint_uses" ]] && ! grep -vqE ' # $(HADOLINT_ACTION)$$' <<<"$$hadolint_uses" \
	  || { echo "ci.yml runs a hadolint-action other than $(HADOLINT_ACTION), whose hadolint HADOLINT copies"; status=1; }; \
	[[ $$status == 0 ]] && echo "pins match ci.yml"; exit $$status

ci: lint cover vuln licenses check-config contract contract-edge contract-csm synthetic-selftest gates-selftest ## The CI go job's gates, locally (the Docker gates are separate targets)

verify: ci rules web-check web-licenses web-e2e web-docker-selftest dockerfile-lint api-lint shellcheck headers workflow-lint pins ## Every local gate (not CI's gitleaks, Trivy or statusd image smoke test); make -k verify reports every failure (needs Node and Docker)

clean: ## Remove build outputs
	rm -rf bin $(GO_DIR)/coverage.out

# Local-only targets (the internal documents), when present.
-include docs/docs.mk
