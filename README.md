# WSO2 Cloud Status

The status page for the WSO2 Cloud products: Agent Platform, API Platform,
Integration Platform, Identity Platform, Developer Platform and Moesif. One
summary page with each product's status per region, a page per product with
its history, regions and incidents, and an incident history by month.

## Repository structure

```text
wso2-cloud-status/
├── backend/go/            # statusd: the status API (Go)
├── frontend/              # the status page (React, WSO2 Oxygen UI) and its nginx image
├── api/openapi.yaml       # the API contract
├── config/                # statusd's configuration: the product catalogue and the sources
├── tests/contract/        # black-box contract tests, and a fake upstream that replays recorded answers
├── testdata/              # recorded upstream answers, normal and edge cases
├── deploy/observability/  # Prometheus alert rules and their unit tests
├── scripts/               # contract runner, fixture capture, gate scripts, pre-push hook
│   └── ops/               # the external synthetic check, its notifier, the image self-test
└── .github/               # CI, CodeQL, release and synthetic-check workflows; Dependabot; issue forms
```

## Components

| Component | Description |
|---|---|
| statusd (`backend/go`) | Polls each product's status source, keeps the last good data, and serves pre-built JSON with its freshness. See the [statusd README](backend/go/README.md): architecture, configuration, adding a product, API, operations. |
| Status page (`frontend`) | Renders the API: the current status, a page per product and the incident history; served by nginx. See the [frontend README](frontend/README.md). |
| External check (`scripts/ops`) | Loads the page, its scripts and the API through the public address on a schedule, and pages when data is old or missing. |
| Alert rules (`deploy/observability`) | Stale data, unknown statuses, errors, latency, load shedding, configuration and the origin lock. |

## Quick start

Requires Go 1.27, golangci-lint (the `GOLANGCI_LINT_VERSION` in
`.github/workflows/ci.yml`), jq, curl and python3; Node per
`frontend/.nvmrc` for the frontend (and `npm run e2e:install` once for the
end-to-end tests); Docker for the Docker-based gates.

```sh
make run          # serve on :8080 (API) and :9090 (metrics, probes) against the live upstream
curl -s localhost:8080/api/v1/summary | jq '.status, [.products[] | {id, status}]'

cd frontend && nvm use && npm ci && npm run dev   # http://localhost:5173, proxies /api to :8080
```

`make help` lists every target. The ones used most:

| Target | What it does |
|---|---|
| `make verify` | every local gate, in order; `make -k verify` reports every failure. Only CI runs gitleaks, Trivy and the statusd image build and smoke test |
| `make hooks` | once per clone: a pre-push hook that runs both unit test suites for any change but Markdown, and the lint and image checks for the folders a push changes (about a minute when everything changed); `git push --no-verify` skips it |
| `make ci` | the CI go job: lint (backend and contract tests), cover, vuln, licenses, check-config, contract, contract-edge, contract-csm, synthetic-selftest, gates-selftest |
| `make lint` | vet, staticcheck, gosec, cyclomatic (10) and cognitive (15) complexity, license headers |
| `make test` | unit and integration tests with the race detector |
| `make cover` | tests plus the coverage gate (85%) |
| `make check-config` | every file in `config/` validated as a start would read it (`statusd -check-config`) |
| `make contract`, `make contract-edge`, `make contract-csm` | contract tests against replayed upstream data: normal, edge cases, and every backend read through the CSM adapter |
| `make live` | smoke test against the real upstream APIs |
| `make docker`, `make web-docker` | the statusd image (distroless, non-root) and the frontend image, with version labels |
| `make web-check` | frontend lint, types, tests with coverage, build, audit |
| `make web-licenses` | licence allow-list for the npm packages the frontend ships |
| `make web-e2e` | frontend end-to-end tests against the real backend |
| `make rules`, `make dockerfile-lint`, `make shellcheck`, `make api-lint`, `make headers`, `make workflow-lint`, `make web-docker-selftest` | the Docker-based gates: alert rules, Dockerfiles, shell scripts, the OpenAPI document, license headers, the workflows, and the frontend image's headers and `security.txt` |
| `make synthetic-selftest`, `make gates-selftest` | the external synthetic check against a local statusd, and the licence and coverage gate scripts, each with passing and failing cases |

## Quality gates (CI)

Lint and complexity, race-detector tests, coverage at or above 85%,
govulncheck, licence allow-lists for Go packages (go-licenses) and shipped
npm packages, every configuration file checked with `statusd -check-config`,
contract tests, OpenAPI lint, alert-rule unit tests, license headers,
shellcheck, gitleaks over the full history, Trivy (dependency
vulnerabilities, licences, misconfiguration; image vulnerabilities),
dependency review with a licence allow-list and OpenSSF Scorecard,
hadolint, actionlint, self-tests of the external check, the gate scripts and
the frontend image's headers, CodeQL, and a nightly live smoke test. Every
action is pinned by commit SHA and kept current by Dependabot, with a 7-day
cooldown for version updates; tools run from images are pinned by digest.
Releases are `v*` tags: `.github/workflows/release.yml` runs CI on the
tagged commit and publishes scanned, signed images with provenance and
SBOMs once a registry is set (see `CHANGELOG.md`). Dependency review and
CodeQL need a public repository, or GitHub Code Security on a private one;
the repository variable `ADVANCED_SECURITY=off` skips them on a private
repository without it.

## Documentation

- [statusd](backend/go/README.md) and the [status page](frontend/README.md):
  each component's architecture, setup and behaviour
- `api/openapi.yaml`: the public API
- [CHANGELOG.md](CHANGELOG.md): changes per release;
  [SECURITY.md](SECURITY.md): how to report a vulnerability

## License

Apache License 2.0. See `LICENSE`.
