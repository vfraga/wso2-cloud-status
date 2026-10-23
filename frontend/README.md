# WSO2 Cloud Status, frontend

The status page for the WSO2 Cloud products: one banner, one row per product with a
90-day strip, active incidents, and the last 14 days of incidents. It reads the
status API in `../backend/go` (contract: `../api/openapi.yaml`) and links each
product to its own status page, where the full history lives.

## Run

Node 24.22.0 (`.nvmrc`).

```sh
npm ci
npm run dev            # http://localhost:5173, proxies /api to http://localhost:8080
npm run lint           # eslint (zero warnings) and prettier
npm run typecheck
npm test               # vitest in UTC with coverage gates (85% lines, statements, functions;
                       # 80% branches), then again in Asia/Colombo and America/Sao_Paulo
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

- Polling, not push: `/api/v1/summary` every 30 s, `/api/v1/incidents` every
  60 s and a product every 30 s (`src/config.ts`), with `cache: "no-cache"` so
  the browser revalidates with the ETag. Polling pauses while the tab is
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
- Words: every status label and sentence is in `src/lib/status.ts`; times go
  through `Intl` in the reader's locale (`src/lib/time.ts`), data times and
  history days in UTC.
- Accessibility: the banner's live region announces late data and headline
  changes; after an in-page navigation focus moves to the new view's h1 once
  it shows data or a failure; the history strip is one tab stop with arrow
  keys; status is never colour alone. axe runs in the end-to-end tests.
- Without JavaScript, or when the app's scripts do not load, `index.html`
  lists every product's own status page (hidden for 3 seconds so a normal
  load does not flash it); the same list appears when the API cannot be
  reached from the first load, and after a rendering error, which retries
  after one summary interval. `fallbackProducts.test.ts` ties both lists to
  `config/statusd.yaml`.

## End-to-end tests

`scripts/e2e.sh` builds `statusd` and the fixture upstream into a temp directory,
builds the site, serves it with `vite preview` (which sends the Content-Security-Policy
of `docker/nginx.conf`, so a violation fails the console checks) and runs one spec per
scenario against a freshly started backend: `ok`, `degraded`, `stale`, `outdated` and `stopped`, then
`stopped` again with the browser in Asia/Colombo (pick some with
`E2E_SCENARIOS="ok stale degraded@America/Sao_Paulo"`; the others run in UTC).
`stopped` removes two fixture files once every source has answered
(`E2E_FIXTURE_DIR`), so an incident feed and a component feed stop after answering.
Ports 18190 to 18193 (override with `E2E_*_PORT`); the script stops at once when one
is already in use, and fails when a server it started exits.
Scenario data lives in `e2e/fixtures/<scenario>/` as overlays on
`../testdata/upstream` (see `e2e/fixtures/README.txt`); that directory is never
modified. Screenshots go to `SHOT_DIR`, a zone's run under a subdirectory.

## Deployment

`Dockerfile` builds the site and serves `dist/` with `nginx-unprivileged` (non-root,
port 8080, security headers, one-year cache for hashed assets, `no-cache` for
`index.html`, `/healthz`). Both base images are pinned by digest. Route `/api` to the
status API at the ingress. Build: `docker build -t wso2-cloud-status-web frontend`.

## Build notes

- `build/stubs.ts` aliases `@mui/x-data-grid`, `@mui/x-date-pickers`,
  `@mui/x-tree-view` and `prismjs` to stubs, for the build and the tests alike. Oxygen
  UI ships one non-tree-shakable bundle that imports them, and this page uses none of
  those components. The alias removes about 125 kB gzip. Do not use Oxygen's data
  grid, date pickers or tree view without removing it. The same bundle keeps about
  40 kB gzip of MUI components the page never renders; only an ES module build of
  Oxygen UI would drop them.
- Oxygen UI inlines its Inter font as `data:` URIs in its JavaScript. `build/externalize-fonts.ts`
  moves each into a content-hashed `.woff2` under `/assets/` and preloads the Latin subset.
- The build has three chunks: `index` (app code, about 17 kB gzip), `vendor`
  (React, MUI, Oxygen, about 183 kB gzip; cached long-term) and a small
  `rolldown-runtime` (under 1 kB).
- `node scripts/transfer.mjs <url>` lists what a page requests on its first load,
  with each file's gzip size (raw for fonts) and the total; the proposal's
  first-load figure comes from it. It needs Playwright's Chromium
  (`npm run e2e:install`) and a running site, such as `npm run preview`.
- Routing is 60 lines of History API code: the current `react-router` requires
  React 19.2.7 or later, and Oxygen UI pins React 19.2.3 exactly.

## Direct dependencies

Production:

| Package                              | Why                                                            |
| ------------------------------------ | -------------------------------------------------------------- |
| `react`, `react-dom` 19.2.3          | UI runtime; exact version pinned by Oxygen UI's peer range     |
| `@wso2/oxygen-ui` 0.16.0             | WSO2 design system (MUI v7 re-export, theming, colour schemes) |
| `@wso2/oxygen-ui-icons-react` 0.16.0 | Lucide icon set used by Oxygen UI                              |

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
