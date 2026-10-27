/**
 * Copyright (c) 2026, WSO2 LLC. (https://www.wso2.com).
 *
 * WSO2 LLC. licenses this file to you under the Apache License,
 * Version 2.0 (the "License"); you may not use this file except
 * in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied. See the License for the
 * specific language governing permissions and limitations
 * under the License.
 */

import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "./App";
import { forgetListedProducts } from "./lib/fallbackProducts";
import { navigate } from "./lib/router";
import { UPTIME_NOTE } from "./lib/status";
import { formatDayHeading } from "./lib/time";
import { apiTime, currentBody, summaryBody } from "./test/factories";

const server = setupServer();
// Neither page asks for the incident list: the home page takes active
// incidents from the summary, and a product's page has its own.
const incidentListRequests: string[] = [];
server.events.on("request:start", ({ request }) => {
  if (new URL(request.url).pathname === "/api/v1/incidents") incidentListRequests.push(request.url);
});
beforeAll(() => {
  server.listen({ onUnhandledFrame: "error" });
});
afterEach(() => {
  server.resetHandlers();
  vi.useRealTimers();
  forgetListedProducts();
  expect(incidentListRequests.splice(0)).toEqual([]);
});
afterAll(() => {
  server.close();
});
beforeEach(() => {
  window.history.pushState(null, "", "/");
});

/** Incidents last read 20 minutes ago: the feed is past its staleness. */
const incidentsStopped = () => {
  const now = apiTime().toISOString();
  return {
    outdated: true,
    checked_at: { components: now, incidents: apiTime(20 * 60_000).toISOString(), uptime: now },
    stale: { components: false, incidents: true, uptime: false },
  };
};

function degradedSummary() {
  return summaryBody({
    status: "degraded",
    products: [
      {
        id: "api-platform",
        name: "API Platform",
        status: "degraded",
        affected_regions: 1,
        data_complete: true,
        ...currentBody(),
        locations: [],
        regions: [
          {
            id: "us",
            name: "US",
            status: "operational",
          },
          { id: "eu", name: "EU", status: "degraded" },
        ],
        history: [
          {
            date: "2026-10-20",
            status: "degraded",
            minutes: { degraded: 30 },
            incident_ids: ["i1"],
          },
        ],
      },
      {
        id: "moesif",
        name: "Moesif",
        status: "operational",
        affected_regions: 0,
        data_complete: true,
        ...incidentsStopped(),
        locations: [],
        regions: [
          {
            id: "us",
            name: "US",
            status: "operational",
          },
        ],
        history: [],
      },
    ],
    active_incidents: [
      {
        id: "i1",
        product_id: "api-platform",
        title: "Elevated latency",
        impact: "degraded",
        state: "investigating",
        started_at: new Date(Date.now() - 3_600_000).toISOString(),
        resolved_at: null,
      },
    ],
  });
}

/**
 * Focus moves in an effect that runs after the h1 is in the document, so this
 * waits for the focus, not for the h1 (on a slow machine the two are apart).
 */
async function expectHeadingFocused(name: string): Promise<void> {
  await waitFor(() => {
    expect(screen.getByRole("heading", { level: 1, name })).toHaveFocus();
  });
}

/** The title is set in an effect after the view renders, so this waits for it. */
async function expectTitle(title: string): Promise<void> {
  await waitFor(() => {
    expect(document.title).toBe(title);
  });
}

/** `summary` is a body, or a function that builds one per request (times move with the clock). */
function serve(summary: unknown) {
  const body = (): unknown =>
    typeof summary === "function" ? (summary as () => unknown)() : summary;
  server.use(
    http.get("http://api.test/api/v1/summary", () =>
      HttpResponse.json(body() as Record<string, unknown>),
    ),
  );
}

describe("home page", () => {
  it("shows the banner, the active incident, and each product's status per region in API order", async () => {
    serve(degradedSummary());
    render(<App />);
    expect(
      await screen.findByRole("heading", {
        level: 1,
        name: "Degraded performance: API Platform",
      }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        "Degraded performance: API Platform (EU). The other product is operational.",
      ),
    ).toBeInTheDocument();
    // The tab names the site only; the status is the h1.
    await expectTitle("WSO2 Cloud Status");
    const table = within(screen.getByRole("region", { name: "Products" })).getByRole("table");
    const rows = within(table).getAllByRole("row").slice(1);
    expect(rows.map((r) => within(r).getByRole("link").textContent)).toEqual([
      "API Platform",
      "Moesif",
    ]);
    const cells = (row: HTMLElement) => within(row).getAllByRole("cell");
    expect(within(cells(rows[0]!)[0]!).getByText("Operational")).toBeInTheDocument();
    expect(within(cells(rows[0]!)[1]!).getByText("Degraded performance")).toBeInTheDocument();
    expect(within(cells(rows[1]!)[0]!).getByText("Operational")).toBeInTheDocument();
    expect(within(cells(rows[1]!)[1]!).getByText("No EU region")).toBeInTheDocument();
    // No history, uptime or past incidents here: they are on each product's page.
    expect(screen.queryByRole("grid")).toBeNull();
    expect(screen.queryByRole("region", { name: "Past incidents" })).toBeNull();
    // A stale incident feed is named once, in the banner, with its time.
    expect(
      screen.getByText(/^Incident information for Moesif has not been updated since .+ UTC\.$/),
    ).toBeInTheDocument();
    const active = screen.getByRole("region", { name: "Active incidents" });
    expect(within(active).getByRole("link", { name: "API Platform" })).toHaveAttribute(
      "href",
      "/products/api-platform",
    );
    expect(within(active).getAllByRole("link")).toHaveLength(1);
    expect(within(active).getByText(/Ongoing for 1h/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Incident history" })).toHaveAttribute(
      "href",
      "/history",
    );
    expect(await screen.findByText(/^Status checked just now$/)).toBeInTheDocument();
  });

  it("says product status is unavailable when the API is down from the first load", async () => {
    server.use(
      http.get("http://api.test/api/v1/summary", () => new HttpResponse(null, { status: 503 })),
    );
    render(<App />);
    expect(
      await screen.findByRole("heading", { level: 1, name: "Status unavailable" }),
    ).toBeInTheDocument();
    expect(await screen.findByText(/Product status is not available/)).toBeInTheDocument();
    const products = screen.getByRole("region", { name: "Products" });
    expect(within(products).queryAllByRole("link")).toHaveLength(0);
    expect(screen.getByRole("status")).toHaveTextContent(
      "We cannot reach the status service right now. This page will keep trying.",
    );
  });

  it.each([{}, { products: [] }, { message: "ok" }])(
    "says product status is unavailable when a summary lists no products: %j",
    async (body) => {
      serve(body);
      render(<App />);
      expect(
        await screen.findByRole("heading", { level: 1, name: "Status unavailable" }),
      ).toBeInTheDocument();
      const products = screen.getByRole("region", { name: "Products" });
      expect(within(products).getByText(/Product status is not available/)).toBeInTheDocument();
      // Nothing to date, and no quiet day vouched for.
      const banner = screen.getByRole("region", { name: "Overall status" });
      expect(within(banner).queryByText(/^Status checked/)).toBeNull();
    },
  );

  it("names a product without data in a grey banner, and in its row", async () => {
    const body = summaryBody();
    const ok = (body.products as Record<string, unknown>[])[0];
    serve(
      summaryBody({
        data_complete: false,
        products: [
          ok,
          {
            id: "moesif",
            name: "Moesif",
            status: "unknown",
            affected_regions: 0,
            data_complete: false,
            outdated: false,
            locations: [],
            regions: [
              {
                id: "us",
                name: "US",
                status: "unknown",
              },
            ],
            history: [{ date: "2026-10-20", status: "unknown" }],
          },
        ],
      }),
    );
    render(<App />);
    expect(
      await screen.findByRole("heading", { level: 1, name: "Status unavailable for Moesif" }),
    ).toBeInTheDocument();
    expect(screen.getByText("The other product is operational.")).toBeInTheDocument();
    const moesif = screen.getAllByRole("row").at(-1)!;
    expect(within(moesif).getByText("Status unavailable")).toBeInTheDocument();
  });

  it("reads Status unavailable at once for a snapshot that was already old on arrival, on the client clock without a Date header", async () => {
    const old = () => {
      const at = apiTime(10 * 60_000);
      const product = { ...(summaryBody().products as Record<string, unknown>[])[0] };
      return summaryBody({
        generated_at: at.toISOString(),
        products: [{ ...product, ...currentBody(at) }],
      });
    };
    server.use(http.get("http://api.test/api/v1/summary", () => HttpResponse.json(old())));
    render(<App />);
    expect(
      await screen.findByRole("heading", { level: 1, name: "Status unavailable" }),
    ).toBeInTheDocument();
    expect(screen.getByText(/^Status checked 1[01] min ago$/)).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("cannot confirm the current status");
  });

  describe("measured on the server's clock", () => {
    const ago = (ms: number) => new Date(Date.now() - ms);
    /** A summary whose snapshot and checks are all at `at` (floored to the minute). */
    const bodyAt = (at: Date) => {
      at.setUTCSeconds(0, 0);
      const product = { ...(summaryBody().products as Record<string, unknown>[])[0] };
      return summaryBody({
        generated_at: at.toISOString(),
        products: [{ ...product, ...currentBody(at) }],
      });
    };
    const serveWith = (body: () => unknown, headers: () => Record<string, string>) => {
      server.use(
        http.get("http://api.test/api/v1/summary", () =>
          HttpResponse.json(body() as Record<string, unknown>, { headers: headers() }),
        ),
      );
    };

    it("a visitor's clock 10 minutes fast does not grey fresh data", async () => {
      // The server's clock reads 10 minutes behind this browser's; its data is 30 s old.
      serveWith(
        () => bodyAt(ago(10 * 60_000 + 30_000)),
        () => ({ Date: ago(10 * 60_000).toUTCString() }),
      );
      render(<App />);
      expect(
        await screen.findByRole("heading", { level: 1, name: "All systems operational" }),
      ).toBeInTheDocument();
      expect(screen.getByText(/^Status checked just now$/)).toBeInTheDocument();
      expect(screen.getByRole("status")).toBeEmptyDOMElement();
    });

    it("a stuck snapshot sent now with data 10 minutes old reads Status unavailable", async () => {
      serveWith(
        () => bodyAt(ago(10 * 60_000)),
        () => ({ Date: new Date().toUTCString() }),
      );
      render(<App />);
      expect(
        await screen.findByRole("heading", { level: 1, name: "Status unavailable" }),
      ).toBeInTheDocument();
    });

    it("times incidents and names Today on the server's clock, one instant for all", async () => {
      // This browser's clock is an hour fast; the incident started 5 minutes ago by the server.
      const serverNow = ago(3_600_000);
      const started = new Date(serverNow.getTime() - 5 * 60_000).toISOString();
      const body = degradedSummary();
      const active = (body.active_incidents as Record<string, unknown>[])[0];
      server.use(
        http.get("http://api.test/api/v1/summary", () =>
          HttpResponse.json(
            { ...body, active_incidents: [{ ...active, started_at: started }] },
            { headers: { Date: serverNow.toUTCString() } },
          ),
        ),
      );
      render(<App />);
      const region = await screen.findByRole("region", { name: "Active incidents" });
      await waitFor(() => {
        expect(within(region).getByText(/Ongoing for/)).toHaveTextContent(/Ongoing for [45]m\./);
      });
    });

    it("counts the Age a cache held the response", async () => {
      // A copy a cache has held for 10 minutes, seen by a browser whose clock is
      // 10 minutes slow: Date and the browser agree, so only Age shows its age.
      serveWith(
        () => bodyAt(ago(5_000)),
        () => ({ Date: new Date().toUTCString(), Age: "600" }),
      );
      render(<App />);
      expect(
        await screen.findByRole("heading", { level: 1, name: "Status unavailable" }),
      ).toBeInTheDocument();
      expect(screen.getByText(/^Status checked 1[01] min ago$/)).toBeInTheDocument();
    });
  });

  it("reads Status unavailable when the page cannot refresh for too long, keeping the rows", async () => {
    vi.useFakeTimers({
      shouldAdvanceTime: true,
      toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"],
    });
    let up = true;
    server.use(
      http.get("http://api.test/api/v1/summary", () =>
        up ? HttpResponse.json(degradedSummary()) : new HttpResponse(null, { status: 503 }),
      ),
    );
    render(<App />);
    const heading = await screen.findByRole("heading", {
      level: 1,
      name: "Degraded performance: API Platform",
    });
    up = false;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(4 * 60_000);
    });
    expect(heading).toHaveTextContent("Degraded performance: API Platform");
    expect(screen.getByRole("status")).toHaveTextContent("We could not refresh it just now");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2 * 60_000);
    });
    expect(heading).toHaveTextContent("Status unavailable");
    expect(screen.getByRole("status")).toHaveTextContent("more than 5 minutes");
    // The last known statuses stay, under the banner that says they may be out of date.
    expect(within(screen.getByRole("table")).getByText("Degraded performance")).toBeInTheDocument();
  });

  it("stops an ongoing incident's duration where the page's own data stops", async () => {
    vi.useFakeTimers({
      shouldAdvanceTime: true,
      toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"],
    });
    const open = {
      id: "i9",
      product_id: "api-platform",
      title: "Gateway timeouts",
      impact: "degraded",
      state: "investigating",
      started_at: apiTime(30 * 60_000).toISOString(),
      resolved_at: null,
    };
    let up = true;
    server.use(
      http.get("http://api.test/api/v1/summary", () =>
        up
          ? HttpResponse.json({ ...degradedSummary(), active_incidents: [open] })
          : new HttpResponse(null, { status: 503 }),
      ),
    );
    render(<App />);
    const active = await screen.findByRole("region", { name: "Active incidents" });
    expect(within(active).getByText(/Ongoing for 30m\.$/)).toBeInTheDocument();
    up = false;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(66 * 60_000);
    });
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Status unavailable");
    // An hour later the page says how long the incident had lasted when it last knew.
    expect(
      within(active).getByText(/Ongoing for at least 30m\. Last known as of .+\.$/),
    ).toBeInTheDocument();
  });

  it("never reads Status unavailable when a tab back after a long absence refreshes at once", async () => {
    vi.useFakeTimers({
      shouldAdvanceTime: true,
      toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"],
    });
    const setHidden = (hidden: boolean): void => {
      Object.defineProperty(document, "hidden", { configurable: true, get: () => hidden });
      document.dispatchEvent(new Event("visibilitychange"));
    };
    serve(degradedSummary);
    render(<App />);
    const heading = await screen.findByRole("heading", {
      level: 1,
      name: "Degraded performance: API Platform",
    });
    const seen = new Set<string>();
    const observer = new MutationObserver(() => {
      seen.add(heading.textContent);
    });
    observer.observe(heading, { childList: true, subtree: true, characterData: true });
    try {
      await act(async () => {
        setHidden(true);
        await vi.advanceTimersByTimeAsync(10 * 60_000);
      });
      await act(async () => {
        setHidden(false);
        await vi.advanceTimersByTimeAsync(0);
      });
      await waitFor(() => {
        expect(screen.getByText(/^Status checked just now$/)).toBeInTheDocument();
      });
      expect(heading).toHaveTextContent("Degraded performance: API Platform");
      expect(seen).not.toContain("Status unavailable");
    } finally {
      observer.disconnect();
      Object.defineProperty(document, "hidden", { configurable: true, get: () => false });
    }
  });

  it("copes with a body of the wrong shape", async () => {
    serve({ status: 42, products: "nope" });
    render(<App />);
    expect(
      await screen.findByRole("heading", { level: 1, name: "Status unavailable" }),
    ).toBeInTheDocument();
  });
});

describe("product page", () => {
  const detail = () => ({
    id: "api-platform",
    name: "API Platform",
    description: "Bijira",
    status: "degraded",
    affected_regions: 1,
    data_complete: true,
    generated_at: apiTime().toISOString(),
    ...incidentsStopped(),
    locations: [],
    regions: [{ id: "eu", name: "EU", status: "degraded" }],
    history: [{ date: "2026-10-20", status: "operational" }],
    region_details: [
      {
        id: "eu",
        name: "EU",
        status: "degraded",
        uptime: [
          { window: "7d", percent: 99.9 },
          { window: "12mo", percent: 99.994 },
        ],
        groups: [
          {
            name: "Runtime",
            status: "degraded",
            components: [
              { name: "API Proxy Invocation", status: "degraded", message: "Slow", uptime: [] },
            ],
          },
        ],
      },
    ],
    incidents: [
      {
        id: "i1",
        product_id: "api-platform",
        title: "Elevated latency",
        impact: "degraded",
        state: "resolved",
        started_at: "2026-10-19T08:00:00Z",
        resolved_at: "2026-10-19T09:00:00Z",
      },
    ],
  });

  it("shows regions, components, uptime and incidents", async () => {
    window.history.pushState(null, "", "/products/api-platform");
    server.use(
      http.get("http://api.test/api/v1/products/api-platform", () => HttpResponse.json(detail())),
    );
    render(<App />);
    expect(await screen.findByText("API Proxy Invocation")).toBeInTheDocument();
    // The h1 names the product, visibly; no second heading repeats it.
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent(
      "API Platform (Bijira): Degraded performance",
    );
    expect(screen.queryByRole("heading", { level: 2, name: "API Platform" })).toBeNull();
    expect(screen.getByText("API Proxy Invocation")).toBeInTheDocument();
    const region = screen.getByRole("button", { name: "EU" });
    expect(document.getElementById(region.getAttribute("aria-controls") ?? "")).toContainElement(
      screen.getByText("API Proxy Invocation"),
    );
    expect(screen.getByText(/^Incidents last updated .+ UTC \(2\d min ago\)$/)).toBeInTheDocument();
    expect(screen.getByText("99.994%")).toBeInTheDocument();
    expect(screen.getByText("Elevated latency")).toBeInTheDocument();
    // The name readers also know it by sits in the title, not on a line of its own.
    expect(screen.queryByText("Bijira")).toBeNull();
    // A component that is not operational says so in words.
    const component = screen.getByText("API Proxy Invocation").closest("li")!;
    expect(within(component).getByText("Degraded performance")).not.toHaveClass(
      "cs-visually-hidden",
    );
    // The footer adds the product's own legal pages under its name.
    const legal = screen.getByRole("navigation", { name: "API Platform legal" });
    expect(within(legal).getByRole("link", { name: "Privacy policy" })).toHaveAttribute(
      "href",
      "https://wso2.com/privacy-policy",
    );
    expect(within(legal).getByRole("link", { name: "Terms of use" })).toHaveAttribute(
      "href",
      "https://wso2.com/api-platform/terms-of-use/",
    );
  });

  it("lists recent incidents under their local day and counts them as the strip does", async () => {
    window.history.pushState(null, "", "/products/api-platform");
    const resolved = (id: string, impact: string, from: string, to: string) => ({
      id,
      product_id: "api-platform",
      title: `Incident ${id}`,
      impact,
      state: "resolved",
      started_at: from,
      resolved_at: to,
    });
    const incidents = [
      resolved("morning", "degraded", "2026-10-20T08:00:00Z", "2026-10-20T09:00:00Z"),
      // Crosses UTC midnight: two strip days, one incident.
      resolved("night", "degraded", "2026-10-19T23:02:00Z", "2026-10-20T00:56:00Z"),
      resolved("earlier", "outage", "2026-10-18T10:00:00Z", "2026-10-18T11:00:00Z"),
    ];
    server.use(
      http.get("http://api.test/api/v1/products/api-platform", () =>
        HttpResponse.json({
          ...detail(),
          ...currentBody(),
          history: [
            {
              date: "2026-10-18",
              status: "outage",
              minutes: { outage: 60 },
              incident_ids: ["earlier"],
            },
            {
              date: "2026-10-19",
              status: "degraded",
              minutes: { degraded: 58 },
              incident_ids: ["night"],
            },
            {
              date: "2026-10-20",
              status: "degraded",
              minutes: { degraded: 116 },
              incident_ids: ["night", "morning"],
            },
          ],
          incidents,
        }),
      ),
    );
    render(<App />);
    const recent = await screen.findByRole("region", { name: "Recent incidents" });
    const titles = within(recent).getAllByRole("heading", { level: 4 });
    expect(
      screen.getByRole("button", { name: `${String(titles.length)} incidents for API Platform` }),
    ).toBeInTheDocument();
    expect(titles.map((t) => t.textContent)).toEqual([
      "Incident morning",
      "Incident night",
      "Incident earlier",
    ]);
    // Each sits under the heading of the local day it started, latest day first.
    const days = within(recent).getAllByRole("heading", { level: 3 });
    const startDays = [...new Set(incidents.map((i) => formatDayHeading(new Date(i.started_at))))];
    expect(days.map((d) => d.textContent)).toEqual(startDays);
    for (const [i, title] of titles.entries()) {
      const day = days.findLast(
        (d) => d.compareDocumentPosition(title) & Node.DOCUMENT_POSITION_FOLLOWING,
      );
      expect(day).toHaveTextContent(formatDayHeading(new Date(incidents[i]!.started_at)));
    }
    // The page names the product; its incidents do not repeat it.
    expect(within(recent).queryByText("API Platform")).toBeNull();
    expect(within(recent).getByText(/^The last 3 days\./)).toBeInTheDocument();
    expect(within(recent).getByRole("link", { name: "Older incidents" })).toHaveAttribute(
      "href",
      "/history?product=api-platform",
    );
    expect(screen.getByText(UPTIME_NOTE)).toBeInTheDocument();
  });

  it("shows an ongoing incident above the history and regions, and not again below", async () => {
    window.history.pushState(null, "", "/products/api-platform");
    const open = {
      id: "i2",
      product_id: "api-platform",
      title: "Gateway timeouts",
      impact: "degraded",
      state: "investigating",
      started_at: new Date(Date.now() - 30 * 60_000).toISOString(),
      resolved_at: null,
    };
    const body = { ...detail(), ...currentBody() };
    server.use(
      http.get("http://api.test/api/v1/products/api-platform", () =>
        HttpResponse.json({ ...body, incidents: [open, ...body.incidents] }),
      ),
    );
    render(<App />);
    const active = await screen.findByRole("region", { name: "Active incidents" });
    expect(within(active).getByRole("heading", { level: 3 })).toHaveTextContent("Gateway timeouts");
    expect(within(active).getByText("Investigating")).toBeInTheDocument();
    // On the product's own page the incident carries no links of its own.
    expect(within(active).queryByRole("link")).toBeNull();
    const regions = screen.getByRole("heading", { level: 2, name: "Regions" });
    const history = screen.getByRole("region", { name: "History" });
    const before = (a: Node, b: Node) =>
      Boolean(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);
    expect(before(active, history)).toBe(true);
    expect(before(active, regions)).toBe(true);
    const recent = screen.getByRole("region", { name: "Recent incidents" });
    expect(within(recent).queryByText("Gateway timeouts")).toBeNull();
    expect(within(recent).getByText("Elevated latency")).toBeInTheDocument();
  });

  it("stops an ongoing incident's duration where the product's data stops", async () => {
    vi.useFakeTimers({
      shouldAdvanceTime: true,
      toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"],
    });
    window.history.pushState(null, "", "/products/api-platform");
    const open = {
      id: "i2",
      product_id: "api-platform",
      title: "Gateway timeouts",
      impact: "degraded",
      state: "investigating",
      started_at: apiTime(30 * 60_000).toISOString(),
      resolved_at: null,
    };
    let up = true;
    server.use(
      http.get("http://api.test/api/v1/products/api-platform", () =>
        up
          ? HttpResponse.json({
              ...detail(),
              ...currentBody(),
              generated_at: apiTime().toISOString(),
              incidents: [open],
            })
          : new HttpResponse(null, { status: 503 }),
      ),
    );
    render(<App />);
    const active = await screen.findByRole("region", { name: "Active incidents" });
    expect(within(active).getByText(/Ongoing for 30m\.$/)).toBeInTheDocument();
    up = false;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(66 * 60_000);
    });
    expect(
      within(active).getByText(/Ongoing for at least 30m\. Last known as of .+\.$/),
    ).toBeInTheDocument();
  });

  it("says incomplete, not unavailable, for a silent feed whose product shows other sources' data", async () => {
    window.history.pushState(null, "", "/products/api-platform");
    const at = apiTime().toISOString();
    server.use(
      http.get("http://api.test/api/v1/products/api-platform", () =>
        HttpResponse.json({
          ...detail(),
          checked_at: { components: at, incidents: null, uptime: null },
          stale: { components: false, incidents: true, uptime: true },
        }),
      ),
    );
    render(<App />);
    // Its EU region shows uptime figures and one incident is listed.
    expect(await screen.findByText("Uptime incomplete")).toBeInTheDocument();
    expect(screen.getByText("Incident information incomplete")).toBeInTheDocument();
    expect(screen.getByText("99.994%")).toBeInTheDocument();
  });

  it("says no other incidents when the only ones are ongoing", async () => {
    window.history.pushState(null, "", "/products/api-platform");
    const open = {
      id: "i2",
      product_id: "api-platform",
      title: "Gateway timeouts",
      impact: "degraded",
      state: "investigating",
      started_at: new Date(Date.now() - 30 * 60_000).toISOString(),
      resolved_at: null,
    };
    server.use(
      http.get("http://api.test/api/v1/products/api-platform", () =>
        HttpResponse.json({ ...detail(), ...currentBody(), incidents: [open] }),
      ),
    );
    render(<App />);
    const recent = await screen.findByRole("region", { name: "Recent incidents" });
    expect(within(recent).getByText("No other incidents reported.")).toBeInTheDocument();
    expect(screen.queryByText("No incidents reported.")).toBeNull();
  });

  it("names missing data and unavailable incidents on a product page", async () => {
    window.history.pushState(null, "", "/products/api-platform");
    const body = {
      ...detail(),
      status: "operational",
      affected_regions: 0,
      data_complete: false,
      ...currentBody(),
      locations: [],
      regions: [
        {
          id: "us",
          name: "US",
          status: "operational",
        },
        { id: "eu", name: "EU", status: "unknown" },
      ],
      history: [{ date: "2026-10-20", status: "unknown" }],
      region_details: [],
      incidents: [],
    };
    server.use(
      http.get("http://api.test/api/v1/products/api-platform", () =>
        HttpResponse.json({
          ...body,
          checked_at: { ...body.checked_at, incidents: null },
          stale: { ...body.stale, incidents: true },
        }),
      ),
    );
    render(<App />);
    expect(
      await screen.findByRole("heading", {
        level: 1,
        name: "API Platform (Bijira): Some status data is unavailable",
      }),
    ).toBeInTheDocument();
    expect(screen.getByText("1 of 2 regions unavailable.")).toBeInTheDocument();
    const recent = screen.getByRole("region", { name: "Recent incidents" });
    expect(
      within(recent).getByText("Incident information for API Platform is unavailable right now."),
    ).toBeInTheDocument();
    expect(screen.queryByText("No incidents reported.")).not.toBeInTheDocument();
    await expectTitle("API Platform - WSO2 Cloud Status");
  });

  it("reads Status unavailable for a complete product response that was old on arrival", async () => {
    window.history.pushState(null, "", "/products/api-platform");
    server.use(
      http.get("http://api.test/api/v1/products/api-platform", () =>
        HttpResponse.json({ ...detail(), generated_at: apiTime(10 * 60_000).toISOString() }),
      ),
    );
    render(<App />);
    expect(
      await screen.findByRole("heading", {
        level: 1,
        name: "API Platform (Bijira): Status unavailable",
      }),
    ).toBeInTheDocument();
  });

  it("says so when the API cannot be reached", async () => {
    window.history.pushState(null, "", "/products/moesif");
    server.use(
      http.get(
        "http://api.test/api/v1/products/moesif",
        () => new HttpResponse(null, { status: 503 }),
      ),
    );
    render(<App />);
    expect(
      await screen.findByText(/Product status is not available right now/),
    ).toBeInTheDocument();
    await expectTitle("Moesif - WSO2 Cloud Status");
  });

  it("says so when the product does not exist", async () => {
    window.history.pushState(null, "", "/products/nope");
    server.use(
      http.get("http://api.test/api/v1/products/nope", () =>
        HttpResponse.json({ title: "Not Found" }, { status: 404 }),
      ),
    );
    render(<App />);
    expect(
      await screen.findByRole("heading", { name: "We could not find that product" }),
    ).toBeInTheDocument();
    await expectTitle("Not found - WSO2 Cloud Status");
  });

  it("reads a 404 for a product the catalogue knows as unavailable, not as missing", async () => {
    window.history.pushState(null, "", "/products/api-platform");
    server.use(
      http.get(
        "http://api.test/api/v1/products/api-platform",
        () => new HttpResponse(null, { status: 404 }),
      ),
    );
    render(<App />);
    expect(
      await screen.findByText(/Product status is not available right now/),
    ).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "We could not find that product" })).toBeNull();
    expect(screen.getByRole("heading", { level: 1 })).toHaveAccessibleName(
      "API Platform: Status unavailable",
    );
  });

  it("knows a product the summary listed even when the built-in list does not", async () => {
    const user = userEvent.setup();
    serve(
      summaryBody({
        products: [
          {
            ...(summaryBody().products as Record<string, unknown>[])[0],
            id: "new-product",
            name: "New Product",
          },
        ],
      }),
    );
    server.use(
      http.get(
        "http://api.test/api/v1/products/new-product",
        () => new HttpResponse(null, { status: 404 }),
      ),
    );
    render(<App />);
    await user.click(await screen.findByRole("link", { name: "New Product" }));
    expect(
      await screen.findByText(/Product status is not available right now/),
    ).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 1 })).toHaveAccessibleName(
      "New Product: Status unavailable",
    );
    expect(screen.queryByRole("heading", { name: "We could not find that product" })).toBeNull();
  });

  it("reads an unreadable product body as unavailable, not as loading", async () => {
    window.history.pushState(null, "", "/products/moesif");
    server.use(
      http.get("http://api.test/api/v1/products/moesif", () => HttpResponse.json({ nope: 1 })),
    );
    render(<App />);
    expect(
      await screen.findByRole("heading", { level: 1, name: "Moesif: Status unavailable" }),
    ).toBeInTheDocument();
    expect(screen.getByText(/Product status is not available right now/)).toBeInTheDocument();
  });

  it("navigates from the home page to a product and back", async () => {
    const user = userEvent.setup();
    serve(degradedSummary());
    server.use(
      http.get("http://api.test/api/v1/products/api-platform", () => HttpResponse.json(detail())),
    );
    render(<App />);
    const products = await screen.findByRole("region", { name: "Products" });
    await user.click(await within(products).findByRole("link", { name: "API Platform" }));
    expect(await screen.findByText("API Proxy Invocation")).toBeInTheDocument();
    // The new view is announced: its h1 has focus and the tab has its own title.
    await expectHeadingFocused("API Platform (Bijira): Degraded performance");
    await expectTitle("API Platform - WSO2 Cloud Status");
    await user.click(screen.getByRole("link", { name: "All products" }));
    await expectHeadingFocused("Degraded performance: API Platform");
    await expectTitle("WSO2 Cloud Status");
    await act(async () => {
      await Promise.resolve();
    });
  });

  it("focuses the h1 only once the status is in, so the status is what is announced", async () => {
    const user = userEvent.setup();
    serve(degradedSummary());
    server.use(
      http.get("http://api.test/api/v1/products/api-platform", async () => {
        await new Promise((done) => setTimeout(done, 300));
        return HttpResponse.json(detail());
      }),
    );
    const focused: string[] = [];
    const record = (event: FocusEvent): void => {
      const target = event.target as HTMLElement;
      if (target.tagName === "H1") focused.push(target.textContent);
    };
    document.addEventListener("focusin", record);
    try {
      render(<App />);
      const products = await screen.findByRole("region", { name: "Products" });
      await user.click(await within(products).findByRole("link", { name: "API Platform" }));
      expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Checking status");
      expect(screen.getByRole("heading", { level: 1 })).not.toHaveFocus();
      await waitFor(() => {
        expect(screen.getByRole("heading", { level: 1 })).toHaveFocus();
      });
      expect(focused).toEqual(["API Platform (Bijira): Degraded performance"]);
    } finally {
      document.removeEventListener("focusin", record);
    }
  });

  it("focuses the h1 of a failed view, and never takes focus the reader moved elsewhere", async () => {
    const user = userEvent.setup();
    serve(degradedSummary());
    server.use(
      http.get("http://api.test/api/v1/products/moesif", async () => {
        await new Promise((done) => setTimeout(done, 200));
        return new HttpResponse(null, { status: 503 });
      }),
      http.get("http://api.test/api/v1/products/api-platform", async () => {
        await new Promise((done) => setTimeout(done, 200));
        return HttpResponse.json(detail());
      }),
    );
    render(<App />);
    const products = await screen.findByRole("region", { name: "Products" });
    await user.click(await within(products).findByRole("link", { name: "Moesif" }));
    const heading = screen.getByRole("heading", { level: 1 });
    await waitFor(() => {
      expect(heading).toHaveFocus();
    });
    expect(heading).toHaveTextContent("Moesif: Status unavailable");
    // Back home, then to a product, moving focus to the theme toggle before its data arrives.
    await user.click(screen.getByRole("link", { name: "All products" }));
    await user.click(
      await within(await screen.findByRole("region", { name: "Products" })).findByRole("link", {
        name: "API Platform",
      }),
    );
    const toggle = screen.getByRole("button", { name: /Switch to (dark|light) mode/ });
    toggle.focus();
    expect(
      await screen.findByRole("heading", {
        level: 1,
        name: "API Platform (Bijira): Degraded performance",
      }),
    ).not.toHaveFocus();
    expect(toggle).toHaveFocus();
  });

  it("focuses the not-found message that replaces a product page", async () => {
    serve(summaryBody());
    server.use(
      http.get("http://api.test/api/v1/products/retired", async () => {
        await new Promise((done) => setTimeout(done, 100));
        return HttpResponse.json({ title: "Not Found" }, { status: 404 });
      }),
    );
    render(<App />);
    await screen.findByRole("heading", { level: 1, name: "All systems operational" });
    act(() => {
      navigate("/products/retired");
    });
    await expectHeadingFocused("We could not find that product");
  });

  it("shows a not-found page for an unknown route", () => {
    window.history.pushState(null, "", "/nothing/here");
    render(<App />);
    expect(
      screen.getByRole("heading", { name: "We could not find that page" }),
    ).toBeInTheDocument();
  });

  it("moves focus to the not-found heading after an in-page navigation to an unknown route", async () => {
    serve(summaryBody());
    render(<App />);
    await screen.findByRole("heading", { level: 1, name: "All systems operational" });
    act(() => {
      navigate("/nothing/here");
    });
    await expectHeadingFocused("We could not find that page");
  });
});

describe("header", () => {
  it("leads home with the WSO2 logo, drawn in the logo colour and hidden from screen readers", async () => {
    serve(summaryBody());
    render(<App />);
    const home = await screen.findByRole("link", { name: "WSO2 Cloud Status, home" });
    const logo = home.querySelector("svg");
    expect(logo).toHaveAttribute("aria-hidden", "true");
    expect(logo?.querySelectorAll("path")).toHaveLength(6);
    expect(home).toHaveTextContent("Cloud Status");
  });
});

describe("footer", () => {
  it("links WSO2's legal pages", async () => {
    serve(summaryBody());
    render(<App />);
    const legal = await screen.findByRole("navigation", { name: "Legal" });
    expect(
      within(legal)
        .getAllByRole("link")
        .map((a) => [a.textContent, a.getAttribute("href")]),
    ).toEqual([
      ["Privacy policy", "https://wso2.com/privacy-policy"],
      ["Cookie policy", "https://wso2.com/cookie-policy"],
      ["Terms of use", "https://wso2.com/terms-of-use"],
      ["Modern slavery statement", "https://wso2.com/modern-slavery-statement"],
      ["Do not sell my personal information", "https://wso2.com/california-privacy#opt-out"],
    ]);
  });
});

describe("theme toggle", () => {
  it("switches between light and dark", async () => {
    const user = userEvent.setup();
    serve(summaryBody());
    render(<App />);
    const toggle = await screen.findByRole("button", { name: "Switch to dark mode" });
    await user.click(toggle);
    expect(await screen.findByRole("button", { name: "Switch to light mode" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Switch to light mode" }));
    expect(await screen.findByRole("button", { name: "Switch to dark mode" })).toBeInTheDocument();
  });
});
