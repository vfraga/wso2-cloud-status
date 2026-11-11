# WSO2 Cloud Status, frontend

The status page for the WSO2 Cloud products. The home page is the current status:
one banner, the active incidents, and a table of each product's status per location (US, EU).
Each product's page has its 90-day history, regions with uptime, and incidents; the
incident history lists every incident the API holds, by month. It reads the status
API in `../backend/go` (contract: `../api/openapi.yaml`).

## Run

Node at the version in `.nvmrc`, which the Dockerfile's build image matches.

```sh
npm ci
npm run dev            # http://localhost:5173, proxies /api to http://localhost:8080
npm run lint           # eslint (zero warnings), a check that it lints every tracked source file,
                       # and prettier
npm run typecheck
npm test               # vitest in UTC with the coverage gates in vitest.config.ts, then
                       # again in Asia/Colombo and America/Sao_Paulo, and the locale
                       # test in German
npm run build          # dist/
npm run e2e:install    # once: downloads Chromium for Playwright
npm run e2e            # builds the backend and site, runs Playwright against the real backend
```

`API_PROXY_TARGET` changes the dev and preview proxy target. `VITE_API_BASE_URL`
(build time) sets the API base URL; empty means same origin. The container's
Content-Security-Policy allows `connect-src 'self'` only, so a cross-origin
`VITE_API_BASE_URL` also needs that origin added to `connect-src` in
`docker/nginx.conf`, or the browser blocks every API call.

## Behaviour

How the frontend behaves in each state, data missing included:

- The home page lists the active incidents the summary holds, at most the
  10 newest per product; a product with more gets a line, "12 more active
  incidents for API Platform", linking its page, which lists every one.
- A history day's durations are the API's minutes for that day.

- Polling, not push: the home page reads `/api/v1/summary` and a product's
  page `/api/v1/products/{id}`, each every 30 s (`src/config.ts`), with
  `cache: "no-cache"` so the browser revalidates with the ETag. Neither reads
  `/api/v1/incidents`. Polling pauses while the tab is
  hidden and refreshes when it is visible again. A request that has not
  answered after 15 s fails; failures back off exponentially to 2 minutes.
- Status: the banner shows the summary's `status`, which statusd computes;
  the page names products and regions around it but computes no status. The
  parser fails closed: `operational` over a body it cannot read in full
  reads `unknown`, a record it cannot read counts as data not received, and
  an impossible date is dropped.
- Freshness comes from the body: `generated_at`, and per product
  `checked_at` and `stale` per kind of data. Ages are measured on the
  server's clock, taken from the response with the newest `Date` plus `Age`
  seen in the session, so a wrong visitor clock or an old CDN copy without
  `Age` does not make data look current. One corrected "now" serves each
  page (`PageNowProvider`).
- The limit is `config.staleAfterMs` (5 minutes, the API's
  `polling.stale_after`; a test keeps them equal). A response already older
  than that on arrival, or no successful refresh for that long after a
  failure, turns the banner to "Status unavailable"; from then on, nothing
  on the page runs past the last data (`useKnownUntil`).
- A body older than the one shown never replaces it, and each API path keeps
  its last state across navigation (`usePolled`).
- Words: every status label and status sentence (headlines, notices, notes,
  the not-found page) is in `src/lib/status.ts`; headings and link texts stay
  with their components. Times go through `Intl` in the reader's locale
  (`src/lib/time.ts`), data times and history days in UTC.
- Accessibility: the banner's live region carries late data and headline
  changes (no screen reader has been tested yet); after an in-page navigation focus moves to the new view's h1 once
  it shows data or a failure; the home page's table states every role, so a
  phone layout keeps it a table; the history strip is one tab stop with
  arrow keys; status is never colour alone. axe runs in the end-to-end tests.
- Without JavaScript, or when the app's scripts do not load, `index.html`
  says so (hidden for 3 seconds so a normal load does not flash it). When
  the API cannot be reached from the first load the products' card says
  their status is not available; a rendering error shows a plain message
  and retries after one summary interval. The page links no product's own
  status page. `src/lib/fallbackProducts.ts` holds each product's id and
  name for a product page that loads before the API answers;
  `fallbackProducts.test.ts` ties it to `config/statusd.yaml`.

## End-to-end tests

`scripts/e2e.sh` builds `statusd` and the fixture upstream into a temp directory,
builds the site, serves it with `vite preview` (which sends the Content-Security-Policy
of `docker/nginx.conf`, so a violation fails the console checks) and runs each
scenario's specs (`e2e/specs/<scenario>.spec.ts`, or `<scenario>-*.spec.ts` for `ok`, split by
subject) against a freshly started backend: `ok`, `degraded`, `stale`, `outdated` and `stopped`, then
`stopped`'s tests tagged `@times`, which read times on screen, again with the browser in
Asia/Colombo (pick some with `E2E_SCENARIOS="ok stale stopped@America/Sao_Paulo"`; a zoned
entry runs only the `@times` tests, the others run in UTC).
`stopped` removes two fixture files once every source has answered
(`E2E_FIXTURE_DIR`), so an incident feed and a component feed stop after answering.
Ports 18190 to 18193 (override with `E2E_*_PORT`); the script stops at once when one
is already in use, and fails when a server it started exits.
Scenario data lives in `e2e/fixtures/<scenario>/` as overlays on
`../testdata/upstream` (see `e2e/fixtures/README.txt`); that directory is never
modified.

## Deployment

`Dockerfile` builds the site and serves `dist/` with `nginx-unprivileged` (non-root,
port 8080, security headers, one-year cache for hashed assets, `no-cache` for
`index.html`, a 404 for paths the page does not have, `/healthz`). Both base images are pinned by digest. Route `/api` to the
status API at the ingress. Build: `docker build -t wso2-cloud-status-web frontend`.

The image does not start without `FRONT_DOOR_ID`, the Front Door profile ID that every
request but `/healthz` must carry in `X-Azure-FDID` (`docker/origin-lock.sh`). Outside
production set `ORIGIN_LOCK=off`, and `INDEXING=off` to send `X-Robots-Tag: noindex`:
`docker run --rm -p 8080:8080 -e ORIGIN_LOCK=off -e INDEXING=off wso2-cloud-status-web`.
The image answers `/api/` with a 404; with nothing in front of it to route `/api`, mount a
replacement `/etc/nginx/api.conf` whose `location /api/` forwards to statusd.

`public/` holds the icons, the WSO2 pulse glyph from the brand pack: `icon.svg`,
and `favicon.ico` and `apple-touch-icon.png`, which `node scripts/icons.mjs`
renders from it. The header logo is `src/components/Wso2Logo.tsx`, the brand
pack's paths unchanged.

## Build notes

- `build/stubs.ts` aliases `@mui/x-data-grid`, `@mui/x-date-pickers`,
  `@mui/x-tree-view` and `prismjs` to stubs, for the build and the tests alike. Oxygen
  UI ships one non-tree-shakable bundle that imports them, and this page uses none of
  those components. The alias removes about 138 kB gzip. Do not use Oxygen's data
  grid, date pickers or tree view without removing it. The same bundle keeps about
  40 kB gzip of MUI components the page never renders; only an ES module build of
  Oxygen UI would drop them.
- Oxygen UI inlines its fonts as `data:` URIs in its JavaScript: Inter, which its WSO2 theme
  uses, and Sora, which only another of its themes uses. `build/externalize-fonts.ts` moves each
  into a content-hashed `.woff2` under `/assets/`, named after its family (`inter-*`, `sora-*`),
  and preloads the Latin subset of the theme's font (`PAGE_FONT`, checked against the theme by
  a test). A browser fetches Sora only if something renders in it; nothing on this page does.
  The build fails when the theme font's Latin subset is missing.
- The build has three chunks: `index` (app code), `vendor` (React, MUI,
  Oxygen; cached long-term) and a small `rolldown-runtime`. `npm run build`
  prints each one's size. The image compresses each file once at
  level 9 and nginx sends the `.gz` copy (`gzip_static`).
- The API is not preloaded from the HTML. Chromium hands a preloaded response
  to the page's first matching request however late it comes (a tab opened in
  the background, a visit that starts on a product page), so the page would
  show an old status as just checked. An end-to-end test checks that both
  cases fetch the status anew.
- `node scripts/transfer.mjs <url>` lists what a page requests on its first load,
  with each file's gzip size (raw for fonts) and the total. It needs Playwright's Chromium
  (`npm run e2e:install`) and a running site, such as `npm run preview`.
- Routing is a small History API router (`src/lib/router.tsx`): the current `react-router` requires
  React 19.2.7 or later, and Oxygen UI pins React 19.2.3 exactly.
- The page is public and reads a public API, so it has no sign-in, no
  authentication provider and no API client library: `src/api/client.ts`
  calls `fetch`, and the browser revalidates with the ETag. Each route polls
  its own resource and keeps its data in its own state; there is no global
  store.

## Direct dependencies

Versions are in `package.json`.

Production:

| Package                       | Why                                                            |
| ----------------------------- | -------------------------------------------------------------- |
| `react`, `react-dom`          | UI runtime; the exact version Oxygen UI's peer range pins      |
| `@wso2/oxygen-ui`             | WSO2 design system (MUI v7 re-export, theming, colour schemes) |
| `@wso2/oxygen-ui-icons-react` | Lucide icon set used by Oxygen UI                              |

Development:

| Package                                                   | Why                                                                                                             |
| --------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `vite`, `@vitejs/plugin-react`                            | Dev server and production build                                                                                 |
| `typescript`, `@types/*`                                  | Type checking (6.0.x; `typescript-eslint` does not yet support 7.x)                                             |
| `vitest`, `@vitest/coverage-v8`, `jsdom`                  | Unit and component tests with coverage gates                                                                    |
| `@testing-library/react`, `dom`, `user-event`, `jest-dom` | Component tests through the accessibility tree                                                                  |
| `msw`                                                     | Mocks our own API in component tests only                                                                       |
| `@playwright/test`, `@axe-core/playwright`                | End-to-end tests against the real backend; accessibility checks                                                 |
| `eslint`, `@eslint/js`, `typescript-eslint`, `globals`    | Linting                                                                                                         |
| `eslint-plugin-react-hooks`, `-sonarjs`                   | Hook rules, cognitive complexity. Accessibility is checked by axe in e2e and role-based Testing Library queries |
| `prettier`                                                | Formatting                                                                                                      |

`package.json` overrides `minimatch` to 11.0.4, and its dependency `@isaacs/nonrecursive-glob-match` to
1.0.3, the version it was released with: `eslint`, `typescript-eslint` and `eslint-plugin-sonarjs` still
ask for minimatch 10, which a crafted glob can slow to a denial of service. Remove the override once all
three accept minimatch 11.
