# Changelog

Notable changes to the WSO2 Cloud status page: the status API (statusd),
the web frontend and their images. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and releases follow
[Semantic Versioning](https://semver.org/spec/v2.0.0.html). A release is a
tag `v<version>` on `main`; the release workflow refuses a tag without a
section here. The public API has its own version, in `api/openapi.yaml`.

## [Unreleased]

### Fixed

- While a product's incident feed is stale, an open incident's daily
  minutes stop at `checked_at.incidents` instead of running to
  `generated_at` (ADR 0009).
- The page stops the product rows and Past incidents where the earlier of
  the summary and the incident list stopped, and the tab title no longer
  keeps the last status after a rendering error.
- An incident record without an id, or with an id another record in the
  same response has, fails the incident fetch instead of hiding the other
  record; a record with an end time is resolved whatever its status word
  (ADR 0005).
- `statusd -check-config` rejects cache directives the cache limits do not
  read (`s-maxage`, a repeated directive) and two listeners on one port
  (ADR 0003).

### Security

- The frontend image applies Alpine's security updates when it is built,
  instead of waiting for a new base image, and no longer contains curl or
  the six libraries only curl used.
- The statusd image is built on the current distroless base image, with
  the Prometheus client library 1.25.0.

## [0.1.0] - 2026-10-23

The first release. Public API version 1.0.0.

### Added

- statusd, the status API in Go. It polls each product's upstream source
  (components and incidents every 30 seconds, uptime every 5 minutes),
  keeps the last good data, and serves prebuilt JSON with strong ETags:
  `GET /api/v1/summary`, `/api/v1/products/{id}` and `/api/v1/incidents`.
  Probes and Prometheus metrics are on a separate admin port.
- API 1.0.0: each body says how fresh it is (`generated_at`), and each
  product says per kind of data when it was last checked (`checked_at`),
  whether that is past its budget (`stale`) and whether its incidents or
  uptime are outdated (`outdated`). The summary `status` fails closed: it
  is `unknown` when data is missing and no problem is known. Clients ignore
  properties they do not know (ADR 0004, ADR 0006, ADR 0009).
- The product catalogue lives in the configuration and reloads without a
  restart; `statusd -check-config <file>` rejects a file the service could
  not serve correctly. `config/statusd.production.yaml` turns on the origin
  lock, which accepts only requests that come through Azure Front Door.
- The status page for Agent Platform, API Platform, Integration Platform,
  Identity Platform, Developer Platform and Moesif, served by unprivileged
  nginx with a Content Security Policy, Strict-Transport-Security and
  `/.well-known/security.txt`. Missing data never reads as healthy, and
  data is never shown as more current than it is.
- Alert rules with unit tests and a runbook section for each, including
  StatusdNoProductData (critical when 4 or more of 6 products have no known
  status, warning when any has none), and an external check of the page
  and API every 5 minutes from GitHub's runners that pages once per failure
  episode.
- Releases: gated on CI, images pushed by digest, scanned, signed keyless,
  with build provenance and CycloneDX SBOMs, and the version tagged last
  (`.github/workflows/release.yml`, off until a registry is set).
