# WSO2 Cloud Status

The status page for the WSO2 Cloud products: Agent Platform, API Platform,
Integration Platform, Identity Platform, Developer Platform and Moesif. One
summary page, one row per product, with links to each product's own status
page.

This repository holds the status API (`backend/go`), the web frontend
(`frontend`, React and WSO2 Oxygen UI), the API contract
(`api/openapi.yaml`) and the contract test suite (`tests/contract`).

## Quick start

Requires Go 1.27, golangci-lint 2.14, jq, curl and python3; Node per
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
| `make ci` | the CI go job: lint (backend and contract tests), cover, vuln, licenses, check-config, contract, contract-edge, synthetic-selftest, gates-selftest, docgen-test |
| `make lint` | vet, staticcheck, gosec, cyclomatic (10) and cognitive (15) complexity, license headers |
| `make test` | unit and integration tests with the race detector |
| `make cover` | tests plus the coverage gate (85%) |
| `make check-config` | every file in `config/` validated as a start would read it (`statusd -check-config`) |
| `make contract`, `make contract-edge` | contract tests against replayed upstream data, normal and edge cases |
| `make live` | smoke test against the real upstream APIs |
| `make docker`, `make web-docker` | the statusd image (distroless, non-root) and the frontend image, with version labels |
| `make web-check` | frontend lint, types, tests with coverage, build, audit |
| `make web-licenses` | licence allow-list for the npm packages the frontend ships |
| `make web-e2e` | frontend end-to-end tests against the real backend |
| `make rules`, `make dockerfile-lint`, `make shellcheck`, `make api-lint`, `make headers`, `make workflow-lint`, `make web-docker-selftest` | the Docker-based gates: alert rules, Dockerfiles, shell scripts, the OpenAPI document, license headers, the workflows, and the frontend image's headers and `security.txt` |
| `make synthetic-selftest`, `make gates-selftest` | the external synthetic check against a local statusd, and the licence and coverage gate scripts, each with passing and failing cases |

## API

| Endpoint | Purpose |
|---|---|
| `GET /api/v1/summary` | overall status, product rows with regions (grouped by location, with uptime) and 90-day history, active incidents |
| `GET /api/v1/products/{id}` | regions, component groups, uptime and incidents for one product |
| `GET /api/v1/incidents` | active incidents and those within the history window |
| `GET /healthz`, `GET /readyz` | probes (also on the admin port) |
| `GET :9090/metrics` | Prometheus metrics, admin port only |

Responses carry a strong ETag; poll with `If-None-Match`. See
`api/openapi.yaml`.

## Configuration

`config/statusd.yaml` lists backends and the product catalogue;
`config/statusd.production.yaml` is the same with the origin lock on, for
production. Unknown keys are rejected and every validation problem is
reported at once; `statusd -check-config <file>` reports them without
starting the service. Changes are picked up live (file change or SIGHUP);
an invalid file is rejected and the running configuration stays. Adding a
product needs no change to the service, only to the configuration, the
frontend's fallback list and the test data. `${NAME}` in a value reads
the environment.

Environment: `STATUSD_CONFIG` (path), `PORT` (overrides the public port),
`STATUSD_LOG_LEVEL` (debug, info, warn, error).

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

- `frontend/README.md`: the web frontend, its behaviour and build
- `api/openapi.yaml`: the public API
- `CHANGELOG.md`: changes per release; `SECURITY.md`: how to report a vulnerability

## License

Apache License 2.0. See `LICENSE`.
