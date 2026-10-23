# Developer entry points. make ci is CI's go job; the Docker targets (rules,
# dockerfile-lint, shellcheck, api-lint, headers, workflow-lint,
# web-docker-selftest) and the web-* targets cover its other jobs. Only CI
# runs gitleaks, Trivy and the statusd image build and smoke test; run its
# compliance and container jobs under act.
SHELL := /bin/bash
.SHELLFLAGS := -euo pipefail -c

GO_DIR       := backend/go
COVERAGE_MIN ?= 85
GOVULNCHECK  := golang.org/x/vuln/cmd/govulncheck@v1.9.0
GOLICENSES   := github.com/google/go-licenses/v2@v2.0.1
LICENSES_OK  := Apache-2.0,MIT,BSD-2-Clause,BSD-3-Clause,ISC
PROMETHEUS   := prom/prometheus:v3.15.0@sha256:efd719c99d83b060d9daefdcf00360461adf279f45ef5391f8d111892118753e
# The hadolint that hadolint/hadolint-action v3.5.0 (ci.yml) runs.
HADOLINT     := ghcr.io/hadolint/hadolint:v2.15.1-debian@sha256:9a3944b7fddcb947d1ffd90829ac1a6e5c30479223358f249d8b96c7d0019e27
SHELLCHECK   := koalaman/shellcheck:v0.11.0@sha256:61862eba1fcf09a484ebcc6feea46f1782532571a34ed51fedf90dd25f925a8d
SPECTRAL     := stoplight/spectral:6.17.0@sha256:c8ffae6ee561b70e80402f1ea669e8b37c74fee48a3dbe2147b71359ed987239
# The SkyWalking Eyes that apache/skywalking-eyes/header v0.9.0 (ci.yml) runs.
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
.PHONY: help fmt lint test cover vuln licenses rules contract contract-edge check-config live build run docker ci clean \
	web-install web-check web-licenses web-e2e web-docker web-docker-selftest dockerfile-lint shellcheck api-lint \
	headers workflow-lint gates-selftest verify \
	synthetic synthetic-selftest

help: ## List targets
	@awk 'BEGIN { FS = ":.*## " } /^[a-zA-Z0-9_-]+:.*## / { printf "  %-20s %s\n", $$1, $$2 }' $(MAKEFILE_LIST)

fmt: ## Format Go code (gofumpt, goimports), backend and contract tests
	cd $(GO_DIR) && golangci-lint fmt ./...
	cd tests/contract && golangci-lint fmt --config ../../$(GO_DIR)/.golangci.yml ./...

lint: ## Lint backend and contract tests: vet, staticcheck, gosec, complexity, license headers
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

ci: lint cover vuln licenses check-config contract contract-edge synthetic-selftest gates-selftest ## The CI go job's gates, locally (the Docker gates are separate targets)

verify: ci rules web-check web-licenses web-e2e web-docker-selftest dockerfile-lint api-lint shellcheck headers workflow-lint ## Every local gate (not CI's gitleaks, Trivy or statusd image smoke test); make -k verify reports every failure (needs Node and Docker)

clean: ## Remove build outputs
	rm -rf bin $(GO_DIR)/coverage.out

# Local-only targets (the internal documents), when present.
-include docs/docs.mk
