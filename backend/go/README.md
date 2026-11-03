# statusd

The status API behind the WSO2 Cloud status page. A small Go service that
polls each product's status source on a schedule, keeps the last good data,
and serves pre-built JSON: the current status of every product per region,
each product's history, regions, uptime and incidents, and every incident
the sources keep.

- [Architecture](#architecture)
- [Developer guide](#developer-guide)
- [Configuration](#configuration)
- [Adding a product](#adding-a-product)
- [API endpoints](#api-endpoints)
- [Operations](#operations)

## Architecture

### Purpose and position

Readers never reach a status source. statusd reads every source itself, on
its own schedule, and builds every answer once per change; a request copies
bytes. Behind a CDN, one request to statusd serves every reader of a path,
so the load on the sources does not grow with readers, which peak during an
incident.

```text
 readers (browsers, API clients)
          |
          v
 Azure Front Door (cache, WAF)  ---->  status page (nginx, frontend/)
          |
          v
 statusd :8080  <---- polls ----  status sources (CSM, or the public status API)
 statusd :9090  ----> metrics and probes (private)
```

### Interactions

| Direction | Peer | Detail |
|---|---|---|
| Inbound | Front Door | Plain HTTP on the public port (`server.addr`, 8080). With the origin lock on, a request without the CDN's header (`server.required_headers`) gets 403. |
| Inbound | Monitoring | Prometheus metrics and probes on the admin port (`server.admin_addr`, 9090), never routed through the public ingress. |
| Outbound | Public status API | HTTPS GET, no credentials (`legacy-status-api` backends). |
| Outbound | CSM | HTTPS GET through CSM's API gateway with an OAuth2 client-credentials token from its issuer (`csm-cloud-status` backends). |

Every outbound request carries its own `X-Request-ID`, which the log line of
a failed fetch names. No request follows a redirect: a 3xx is a failed fetch
that names its target. Base and token URLs must be HTTPS (plain HTTP only on
a loopback host, for local fakes).

statusd stores nothing on disk; everything it serves is rebuilt from its
sources after a restart.

### From a poll to an answer

1. Each source (a backend and a cloud) has three reads, polled
   independently: components and incidents every 30 seconds, uptime every 5
   minutes, with jitter, backing off exponentially from 1 second after a
   failure, up to the interval. A failed fetch keeps the last good data.
2. Every answer is validated and bounded: a component without a known
   status reads unknown, an uptime figure that is not a percentage is
   dropped, and a value of the wrong JSON type, an incident without a unique
   id, or an answer over its caps (500 incidents, for example) fails the
   fetch.
3. After every poll, `aggregator.build()` derives every view, and the
   store encodes each once (JSON, gzip and a strong ETag) and swaps the set
   in atomically.
4. Every body says how fresh it is: `generated_at` (when the answer was
   built) and, per product, `checked_at` and `stale` for each kind of data.
   Both times are UTC floored to the minute, so a body changes at most once
   a minute while nothing else does.

### Statuses

- Statuses are operational, maintenance, degraded and outage, by severity,
  and `unknown`, which never means healthy.
- A component, group, region and product take the most severe known status
  under them; an unknown input is skipped and sets `data_complete` to false.
  A location (US, EU) and the summary fail closed: `unknown` when an input
  is unknown and none is in maintenance or worse. The summary `status` is
  the page's headline; the page computes no status of its own.
- `extent` says whether a status covers every region under a roll-up
  ("all") or only some ("some").
- An active incident (no end time) raises its product to its impact.
  Records of one event (same title, impact and state, starts and ends
  within 60 seconds of each other) are one incident.
- Component data older than its budget (5 minutes) reads unknown; stale
  incidents and uptime keep their last data and are flagged.
- The history has one day per UTC day, coloured by the worst incident that
  overlaps it; days no data covers read "no data". Uptime is the source's
  figure per region, as the source reports and rounds it.

### Request pipeline

`internal/httpapi` wraps the public routes in these middlewares, outermost
first: security headers, a `no-store` default for `Cache-Control`, CORS,
the request ID (a caller's well-formed `X-Request-ID`, or a new one), the
origin lock, load shedding (beyond `server.max_in_flight` requests in
flight, a 503 with `Retry-After: 1`), the access log, panic recovery and
CORS preflights. Probes are exempt from the origin lock and from load
shedding. The server bounds slow clients with read-header (5 s), read and
write (10 s) and idle (60 s) timeouts and caps request headers.

### Project structure

```text
backend/go/
├── cmd/statusd/          # Entry point: flags, -check-config, signals, listeners
├── internal/
│   ├── app/              # Wires configuration, sources, aggregator and listeners; live reload
│   ├── config/           # Strict YAML, defaults, ${NAME} references, validation
│   ├── source/           # The source interface and registry
│   │   └── legacyapi/    # Both adapters: the public status API and CSM (token, envelope, 429 hold)
│   ├── aggregator/       # Polling loops, last good data, staleness, build() of every view
│   ├── domain/           # Statuses, roll-ups, the daily history; no I/O
│   ├── httpapi/          # Snapshot store, handlers, middleware, probes
│   └── telemetry/        # Prometheus metrics on a private registry
├── Dockerfile            # Distroless, non-root image; both configuration files inside
└── .golangci.yml         # Lint, complexity and license-header rules
```

## Developer guide

### Prerequisites

- Go at the version in `go.mod`, and golangci-lint at the
  `GOLANGCI_LINT_VERSION` in `.github/workflows/ci.yml`
- Docker for the image and the Docker-based gates
- jq and curl for the contract tests

### Build and run

From the repository root:

```sh
make build        # bin/statusd
make run          # serves :8080 (API) and :9090 (metrics, probes) against the public status API
curl -s localhost:8080/api/v1/summary | jq '.status, [.products[] | {id, status}]'
make docker       # the image, with version labels
```

### Test

```sh
make test             # unit and integration tests with the race detector
make cover            # the same with the coverage gate
make lint             # vet, staticcheck, gosec, complexity, license headers
make contract         # the contract suite against a running statusd, on recorded upstream answers
make contract-edge    # the same on edge-case answers
make contract-csm     # the same with every backend read through the CSM adapter
make ci               # everything CI's Go job runs
```

The contract tests (`tests/contract`, started by `scripts/contract.sh`)
validate every response against `api/openapi.yaml`, check the roll-up rules
on the answers, and check the HTTP behaviour: ETag and 304,
`Last-Modified`, gzip, HEAD, CORS, problem+json errors and a
`Cache-Control` on every response.

## Configuration

`config/statusd.yaml` holds the service settings, the backends and the
product catalogue; `config/statusd.production.yaml` is the same file with
the origin lock on, and a test fails when they differ in anything else.
The image holds both and reads the production file unless
`STATUSD_CONFIG` names another.

- Unknown keys are rejected, and every problem is reported at once.
  `statusd -check-config <file>` reads a file the way a start would and
  exits 0 when it would start, 1 when it would not (the reasons on stderr)
  and 2 for a wrong command line. CI checks every file in `config/`.
- `${NAME}` reads the environment, only as the whole value of a backend
  option (a credential) or of a `server.required_headers` entry (the origin
  lock's ID). Anywhere else it is an error, as is a YAML alias; an unset
  variable fails validation. Keep secrets out of the file.
- statusd reloads the file when its content changes (checked every
  `reload.watch_interval`, 10 s) or on SIGHUP. An invalid file is rejected
  whole and the running configuration stays. `server`, `reload` and every
  backend that reads the environment apply only on a restart; a reload
  reports them in `restart_pending`. The start and reload logs name each
  backend's hosts.
- `server.cache_control` must have a positive `max-age`, `max-age` plus
  `stale-while-revalidate` under the page's 30-second poll, and
  `stale-if-error` within `polling.stale_after`.

Environment: `STATUSD_CONFIG` (the file), `PORT` (overrides the public
port), `STATUSD_LOG_LEVEL` (debug, info, warn, error), and every `${NAME}`
the file references (`FRONT_DOOR_ID` in the production file, a CSM
backend's client secret).

## Adding a product

When the product's status lives in a supported source, statusd needs no
code change; three other places list the products, and tests fail until
they agree.

1. Find the product's cloud key and region keys in its status data (for
   the public status API, `GET /api/v1/monitors?cloud=<key>` lists the
   regions).
2. Add it under `products` in both configuration files, in the position it
   should appear. Every source needs at least one region. A region that is
   a part of a place (a control plane, a data plane) names the place in
   `location` and starts its name with it; every region of the product
   then has one:

   ```yaml
   - id: new-product                # public and stable: part of the API
     name: New Product
     description: Other Name        # optional, shown beside the name
     sources:
       - backend: cloudservices
         cloud: new-product
         regions:
           - { key: "cp - us", id: us-control-plane, name: US control plane, location: US }
   ```

3. Add it to `frontend/src/lib/fallbackProducts.ts`, in the same position,
   with the same `id` and `name`, and its privacy policy and terms of use
   to `PRODUCT_LEGAL` in the same file.
4. Record its upstream answers for the tests:
   `scripts/capture-fixtures.sh <cloud>` saves them to `testdata/upstream`
   from the public status API, while the product is operational.
5. Run `make check-config test contract`, and `npm test` and
   `npm run e2e` in `frontend/`.

A new kind of source needs an adapter: a `source.Factory` that builds a
`source.Provider` for one backend and rejects options it does not
understand, whose `Source(cloud)` returns a `source.Source` with the three
reads. Register it in `internal/app/sources.go` under a backend `type`.

## API endpoints

| Endpoint | Purpose |
|---|---|
| `GET /api/v1/summary` | the overall status, each product's status per location and region, active incidents |
| `GET /api/v1/products/{id}` | one product: regions, component groups, uptime, 90-day history and its incidents |
| `GET /api/v1/incidents` | every incident the sources keep, with each product's coverage and freshness |
| `GET /healthz`, `GET /readyz` | probes, on both ports |
| `GET /metrics` | Prometheus metrics, admin port only |

`api/openapi.yaml` is the contract. Responses carry a strong ETag and a
`Last-Modified` no later than `Date`, and answer conditional requests with
304; errors are `application/problem+json` and are never cached. Versions
within `/api/v1` only add: clients ignore properties they do not know.

## Operations

- Logs are JSON on stdout. Every change of a product's published status is
  one info line; a failed fetch is a warn line with its source, kind, error
  and the request's `X-Request-ID`. Requests below 500 are logged at debug
  level only.
- Metrics (`statusd_*`) cover requests, upstream fetches and their last
  success, the last published snapshot, configuration reloads and the
  file's validity, the origin lock, each product's data completeness and
  region keys that differ from the configuration.
- `deploy/observability/prometheus-rules.yaml` holds the alert rules, with
  their unit tests (`make rules`). `scripts/ops/synthetic-check.sh` is the
  external check of the page and the API through the public address,
  scheduled by `.github/workflows/synthetic.yml`.
