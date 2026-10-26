# Changelog

Notable changes to the WSO2 Cloud status page: the status API (statusd),
the web frontend and their images. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and releases follow
[Semantic Versioning](https://semver.org/spec/v2.0.0.html). A release is a
tag `v<version>` on `main`; the release workflow refuses a tag without a
section here. The public API has its own version, in `api/openapi.yaml`.

## [Unreleased]

### Added

- API 1.1.0: each product lists its `locations` (US, EU) with a status
  that fails closed over their regions, and each region names its
  `location`; summary regions carry their `uptime`.
- Each colour in the history legend has its own label, and a description
  on hover, keyboard focus or tap.
- The WSO2 logo heads the page, and the WSO2 pulse glyph is the favicon and
  the home-screen icon.
- The footer links WSO2's privacy policy, cookie policy, terms of use,
  modern slavery statement and California opt-out page, as the product
  status pages do.

### Changed

- The home page shows the current status at a glance: the banner, the
  active incidents while there are any, and a table with a row per product
  and a column per region (US, EU). Each cell is the region's status as
  icon and word, naming the planes that are not operational, and the whole
  row opens the product's page. On a phone each row puts its regions side
  by side under the product's name. History, uptime and incidents are on
  each product's page; the home page no longer fetches the incident list.
- Control and data planes are parts of a region: each product's page lists
  US and EU with their planes. Region names are in sentence case ("EU data
  plane").
- Links to other sites take the text colour with an underline, so they no
  longer look like a status.
- A day's details put its status beside the date.
- The home page's tab reads "WSO2 Cloud Status"; the status is no longer in
  it.
- A fresh page reads "Status checked just now": while the data is current,
  its age counts from the end of the minute the API reports, since those
  times are floored and can trail the latest check by a minute. Data past
  its limit is aged as before.
- The history legend says what a bar is on its own line, with the colours
  centred below it, each drawn the same size.
- The frontend image sends its files compressed once at the highest level
  instead of at the lowest level on every request: about 37 KB less on a
  first visit, and far less CPU per request.
- An open home page no longer redraws its table on each 5-second tick of
  the banner's clock.
- A product's page lists the incidents of its history's days under the
  reader's local day they started, without repeating the product's name,
  and links older incidents on the product's own status page. The API's
  product `incidents` holds the same days, as `/api/v1/incidents` does.
- The history strip counts incidents, each once however many UTC days it
  touches ("1 incident", "2 incidents and 1 maintenance window"), and names
  its span when it shows fewer days than the incident list ("No incidents
  in 30 days").
- One line under a product's regions says what its uptime figures count:
  outages only, a region's figure averaging its services.
- Today's history bar is at least as severe as the product's worst current
  region status, and says "no incident reported yet" until one is filed.
- On the home page, a product whose active incident names no region shows
  its status under its name ("Service outage, region not stated").
- On a phone, the home table puts a product's regions one under the other
  when they do not fit side by side.
- The footer is centred, and the copyright year follows the clock.
- A product's regions sit in aligned columns: the window codes once per
  location, every row's figures in shared columns, a description under a
  name, and an operational component as a check alone.
- A product's page heads "Developer Platform (Choreo): All systems
  operational", the other name lighter, instead of a line of its own, and
  its footer adds the product's privacy policy and terms of use.
- Every history bar is rounded at both ends; a short one no longer has a
  square top.
- A component the source publishes no uptime for shows a muted dash in its
  columns, read as "not published".
- Legend entries are buttons: Enter or Space shows a colour's description.
- A screen reader hears the status of every plane a home cell names.

### Fixed

- When the page's own data stops, the history no longer paints the days
  after that point green: a day not fully covered reads "No data" unless a
  problem is known, as it already did when a product's incident feed
  stopped.
- On a phone, a tapped legend description stays open until the reader taps
  elsewhere, instead of closing 1.5 s after the tap.
- A screen reader no longer hears "Status changed" again with every later
  notice: the change announcement has its own live region.
- The loading placeholder no longer carries a label a plain element may
  not have (an accessibility error while the page loads); an accessibility
  scan of the loading state now runs with the others.
- A day with maintenance is labelled "Maintenance", not the present-tense
  "Under maintenance", as the legend has it.
- The home table's statuses are no longer cut off at 320 px or under
  WCAG text spacing.
- The history strip no longer announces a selected day: it is a grid of
  days, not a list to choose from.
- A day before a product's incident coverage, or while one of its sources
  has never answered, shows the incidents known for it instead of "No
  data".
- An incident whose end precedes its start marks its start day instead of
  no day.
- A screen reader hears each uptime list's region, and its windows in
  words ("7 days").
- A region on a product's page that the reader opened or closed keeps
  that state when its status changes.
- `history.days` may be any number of days from 1 to 366; the 15-day
  minimum served the home page's list of past incidents, which is gone.
- statusd lists each incident once at a cost that grows with the number of
  records rather than its square, and rejects an incident answer of more
  than 500 records as malformed: an upstream that filed one event
  thousands of times stalled every product's polling for minutes. A
  shutdown no longer waits for the builds queued behind the one running.
- A start, a reload and `statusd -check-config` read the configuration the
  same way. Backend names must be slugs (two sources could share a key and
  show each other's status), and listen addresses take an IP address or no
  host, not a host name. A start refused by an adapter's setting exits 2
  with `configuration rejected` and every problem, like a validation error.
  A reload that is invalid together with the running restart-only settings
  is rejected.
- A percent-encoded spelling of an API path (`/api/v1/%73ummary`) is
  answered with the cacheable 404, not a second copy of the body.
- The plain and gzip bodies have distinct strong ETags.
- The external check also fetches the incident list and a product page,
  so an edge fault on either route alerts instead of passing.
- The frontend image sends nginx's early errors (a request with oversized
  headers or URI) with `no-store`, so a CDN cannot keep one in place of a
  file.
- While a product's incident feed is stale, an open incident's daily
  minutes stop at `checked_at.incidents` instead of running to
  `generated_at`.
- When the page's own data stops, nothing on it runs past that point, and
  the tab title no longer keeps the last status after a rendering error.
- An incident record without an id, or with an id another record in the
  same response has, fails the incident fetch instead of hiding the other
  record; a record with an end time is resolved whatever its status word.
- The page no longer moves as its data arrives (a cumulative layout shift
  of 0.37 to 0.86 on the old home page): until the status answers it shows
  a placeholder the shape of what replaces it, and the fallback shown
  before the app starts no longer moves the page.
- `statusd -check-config` rejects cache directives the cache limits do not
  read (`s-maxage`, a repeated directive) and two listeners on one port.

### Security

- The statusd image starts with the origin-locked production configuration
  by default and does not start without `FRONT_DOOR_ID`. Local runs and the
  demo select `/etc/statusd/statusd.yaml` with `STATUSD_CONFIG`.
- The release workflow's image scans no longer restore an Actions cache: a
  job holding signing credentials must not run a tool that any job on
  `main` could have planted. `make pins` checks every privileged job.
- The frontend image applies Alpine's security updates when it is built,
  instead of waiting for a new base image, and no longer contains curl or
  the six libraries only curl used.
- The statusd image is built on the current distroless base image, with
  the Prometheus client library 1.25.0.

## [0.1.0] - not released

The first version. Nothing is published yet: no image, tag or GitHub
release. Public API version 1.0.0.

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
  properties they do not know.
- The product catalogue lives in the configuration and reloads without a
  restart; `statusd -check-config <file>` rejects a file the service could
  not serve correctly. `config/statusd.production.yaml` turns on the origin
  lock, which accepts only requests that come through Azure Front Door.
- The status page for Agent Platform, API Platform, Integration Platform,
  Identity Platform, Developer Platform and Moesif, served by unprivileged
  nginx with a Content Security Policy, Strict-Transport-Security and
  `/.well-known/security.txt`. Missing data never reads as healthy, and
  data is never shown as more current than it is.
- Alert rules with unit tests, including
  StatusdNoProductData (critical when 4 or more of 6 products have no known
  status, warning when any has none), and an external check of the page
  and API every 5 minutes from GitHub's runners that pages once per failure
  episode.
- Releases: gated on CI, images pushed by digest, scanned, signed keyless,
  with build provenance and CycloneDX SBOMs, and the version tagged last
  (`.github/workflows/release.yml`, off until a registry is set).
