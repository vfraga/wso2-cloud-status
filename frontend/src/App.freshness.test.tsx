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

import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "./App";
import { forgetListedProducts } from "./lib/fallbackProducts";
import { formatUtcClock, formatUtcDateTime } from "./lib/time";
import { apiStatus } from "./test/factories";

/*
 * The page against bodies that carry generated_at, checked_at and stale:
 * body freshness, stopped incident feeds and the product page's lines.
 */

const server = setupServer();
beforeAll(() => {
  server.listen({ onUnhandledFrame: "error" });
});
afterEach(() => {
  server.resetHandlers();
  forgetListedProducts();
  vi.useRealTimers();
});
afterAll(() => {
  server.close();
});
beforeEach(() => {
  window.history.pushState(null, "", "/");
  // Mid-afternoon UTC, so "today" and the times named stay on one UTC day.
  vi.useFakeTimers({ shouldAdvanceTime: true, toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-21T14:17:30Z"));
});

/** A server time `ms` ago, floored to the minute as the API sends it. */
const ago = (ms: number): Date => {
  const t = new Date(Date.now() - ms);
  t.setUTCSeconds(0, 0);
  return t;
};
const iso = (d: Date | null): string | null => (d === null ? null : d.toISOString());

interface Feeds {
  components?: Date | null;
  incidents?: Date | null;
  uptime?: Date | null;
  stale?: { components?: boolean; incidents?: boolean; uptime?: boolean };
}

function productBody(
  id: string,
  name: string,
  extra: Record<string, unknown> = {},
  feeds: Feeds = {},
) {
  const now = ago(0);
  const stale = { components: false, incidents: false, uptime: false, ...feeds.stale };
  return {
    id,
    name,
    status: "operational",
    affected_regions: 0,
    data_complete: true,
    outdated: stale.incidents || stale.uptime,
    checked_at: {
      components: iso(feeds.components === undefined ? now : feeds.components),
      incidents: iso(feeds.incidents === undefined ? now : feeds.incidents),
      uptime: iso(feeds.uptime === undefined ? now : feeds.uptime),
    },
    stale,
    locations: [],
    regions: [
      {
        id: "us",
        name: "US",
        status: "operational",
      },
    ],
    history: [
      { date: ago(86_400_000).toISOString().slice(0, 10), status: "operational" },
      { date: ago(0).toISOString().slice(0, 10), status: "operational" },
    ],
    ...extra,
  };
}

const unknownRegion = {
  status: "unknown",
  data_complete: false,
  regions: [{ id: "us", name: "US", status: "unknown" }],
};

function serve(
  products: unknown[],
  options: {
    generatedAt?: Date;
    active?: unknown[];
  } = {},
) {
  const generated = iso(options.generatedAt ?? ago(0));
  const complete = products.every((p) => (p as { data_complete: boolean }).data_complete);
  server.use(
    http.get("http://api.test/api/v1/summary", () =>
      HttpResponse.json(
        {
          status: apiStatus(products),
          data_complete: complete,
          generated_at: generated,
          products,
          active_incidents: options.active ?? [],
        },
        { headers: { Date: new Date().toUTCString() } },
      ),
    ),
  );
}

const banner = () => screen.getByRole("region", { name: "Overall status" });

describe("body freshness on the home page", () => {
  it("dates the page by the current products and names the one that went silent", async () => {
    const old = ago(2 * 3_600_000);
    serve([
      productBody("a", "A"),
      productBody("b", "B"),
      productBody("moesif", "Moesif", unknownRegion, {
        components: old,
        stale: { components: true },
      }),
    ]);
    render(<App />);
    expect(
      await screen.findByRole("heading", { level: 1, name: "Status unavailable for Moesif" }),
    ).toBeInTheDocument();
    expect(within(banner()).getByText("The other 2 products are operational.")).toBeInTheDocument();
    expect(within(banner()).getByText(/^Other products checked just now$/)).toBeInTheDocument();
    const notice = screen.getByRole("status");
    expect(notice).toHaveTextContent(
      `Status data for Moesif was last checked at ${formatUtcClock(old)}.`,
    );
    expect(notice).not.toHaveTextContent("may be out of date");
  });

  it("shows no age beside a product whose data never arrived", async () => {
    window.history.pushState(null, "", "/products/moesif");
    server.use(
      http.get("http://api.test/api/v1/products/moesif", () =>
        HttpResponse.json({
          ...productBody("moesif", "Moesif", unknownRegion, {
            components: null,
            incidents: null,
            uptime: null,
            stale: { components: true, incidents: true, uptime: true },
          }),
          generated_at: iso(ago(0)),
          region_details: [],
          incidents: [],
        }),
      ),
    );
    render(<App />);
    expect(
      await screen.findByRole("heading", { level: 1, name: "Moesif: Status unavailable" }),
    ).toBeInTheDocument();
    expect(within(banner()).queryByText(/^Status checked/)).toBeNull();
    expect(screen.getByRole("status")).toHaveTextContent(
      "No status data has been received yet for Moesif.",
    );
    // Never answered: no time to name, and the never-answered wording stays.
    expect(screen.getByText("Incident information unavailable")).toBeInTheDocument();
    expect(screen.getByText("Uptime unavailable")).toBeInTheDocument();
    expect(
      screen.getByText("Incident information for Moesif is unavailable right now."),
    ).toBeInTheDocument();
    expect(within(banner()).queryByText(/has not been updated/)).toBeNull();
  });

  it("reads an old snapshot as an old copy even with incomplete data", async () => {
    serve(
      [
        productBody("a", "A"),
        productBody("moesif", "Moesif", unknownRegion, {
          components: null,
          stale: { components: true },
        }),
      ],
      { generatedAt: ago(10 * 60_000) },
    );
    render(<App />);
    expect(
      await screen.findByRole("heading", { level: 1, name: "Status unavailable" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("cannot confirm the current status");
  });
});

describe("an incident feed that stopped after answering", () => {
  // Computed in each test, after the clock is pinned.
  const stoppedAt = () => ago(12 * 60_000);
  const moesif = () =>
    productBody("moesif", "Moesif", {}, { incidents: stoppedAt(), stale: { incidents: true } });

  it("names it in the banner and on its active incident", async () => {
    const time = formatUtcClock(stoppedAt());
    const open = {
      id: "m1",
      product_id: "moesif",
      title: "Event ingestion delays",
      impact: "degraded",
      state: "investigating",
      started_at: ago(40 * 60_000).toISOString(),
      resolved_at: null,
    };
    serve([productBody("a", "A"), { ...moesif(), status: "degraded" }], {
      active: [open],
    });
    render(<App />);
    await screen.findByRole("heading", { level: 1, name: "Degraded performance" });
    // Banner: the headline stays; one secondary line.
    expect(
      within(banner()).getByText(
        `Incident information for Moesif has not been updated since ${time}.`,
      ),
    ).toBeInTheDocument();
    // Active incident: last known.
    const active = screen.getByRole("region", { name: "Active incidents" });
    // It had lasted 28 minutes when last known; that figure does not grow.
    expect(
      within(active).getByText(
        new RegExp(`Ongoing for at least 28m\\. Last known as of ${time}\\.$`),
      ),
    ).toBeInTheDocument();
  });

  it("is not named again in the banner when the product is already unavailable", async () => {
    serve([
      productBody("a", "A"),
      productBody("moesif", "Moesif", unknownRegion, {
        components: stoppedAt(),
        incidents: stoppedAt(),
        stale: { components: true, incidents: true },
      }),
    ]);
    render(<App />);
    await screen.findByRole("heading", { level: 1, name: "Status unavailable for Moesif" });
    expect(within(banner()).queryByText(/has not been updated/)).toBeNull();
    expect(screen.getByRole("status")).toHaveTextContent(
      `Status data for Moesif was last checked at ${formatUtcClock(stoppedAt())}.`,
    );
  });

  it("shows both lines on the product page when incidents and uptime are stale", async () => {
    const feeds = {
      incidents: stoppedAt(),
      uptime: ago(3 * 3_600_000),
      stale: { incidents: true, uptime: true },
    };
    window.history.pushState(null, "", "/products/moesif");
    server.use(
      http.get("http://api.test/api/v1/products/moesif", () =>
        HttpResponse.json({
          ...productBody("moesif", "Moesif", {}, feeds),
          generated_at: iso(ago(0)),
          region_details: [],
          incidents: [],
        }),
      ),
    );
    render(<App />);
    expect(await screen.findByText(/^Incidents last updated/)).toBeInTheDocument();
    expect(screen.getByText(/^Uptime last updated/)).toBeInTheDocument();
  });

  it("marks the partly covered day and the incomplete list on the product page", async () => {
    window.history.pushState(null, "", "/products/moesif");
    server.use(
      http.get("http://api.test/api/v1/products/moesif", () =>
        HttpResponse.json({
          ...moesif(),
          generated_at: iso(ago(0)),
          region_details: [],
          incidents: [],
        }),
      ),
    );
    render(<App />);
    await screen.findByRole("heading", { level: 1, name: "Moesif: All systems operational" });
    const strip = screen.getByRole("grid");
    const options = within(strip).getAllByRole("gridcell");
    expect(options.at(-1)).toHaveAccessibleName(
      new RegExp(`Incident information complete only until ${formatUtcClock(stoppedAt())}\\.$`),
    );
    expect(
      screen.getByText(
        `Incident information for Moesif is incomplete after ${formatUtcDateTime(stoppedAt())}.`,
        { exact: false },
      ),
    ).toBeInTheDocument();
    expect(screen.queryByText("No incidents reported.")).toBeNull();
    expect(
      within(banner()).getByText(/Incident information for Moesif has not been updated since/),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/No data: information for this day is unavailable/),
    ).toBeInTheDocument();
  });

  it("says incomplete, not unavailable, when one source never answered and another's incident is shown", async () => {
    const open = {
      id: "d1",
      product_id: "dev",
      title: "Build delays",
      impact: "degraded",
      state: "investigating",
      started_at: ago(600_000).toISOString(),
      resolved_at: null,
    };
    const dev = productBody(
      "dev",
      "Developer Platform",
      {},
      {
        incidents: null,
        stale: { incidents: true },
      },
    );
    serve([{ ...dev, status: "degraded" }], { active: [open] });
    render(<App />);
    await screen.findByRole("region", { name: "Active incidents" });
    expect(
      within(banner()).getByText(
        "Incident information for Developer Platform is incomplete right now.",
      ),
    ).toBeInTheDocument();
  });

  it("names a feed that never answered in the banner while the product's status is known", async () => {
    serve([
      productBody("a", "A"),
      productBody("moesif", "Moesif", {}, { incidents: null, stale: { incidents: true } }),
    ]);
    render(<App />);
    await screen.findByRole("heading", { level: 1, name: "All systems operational" });
    expect(
      within(banner()).getByText("Incident information for Moesif is unavailable right now."),
    ).toBeInTheDocument();
  });
});

describe("legend and footer", () => {
  it("explains the strip on a product's page and says history days are UTC days", async () => {
    window.history.pushState(null, "", "/products/a");
    server.use(
      http.get("http://api.test/api/v1/products/a", () =>
        HttpResponse.json({
          ...productBody("a", "A"),
          generated_at: iso(ago(0)),
          region_details: [],
          incidents: [],
        }),
      ),
    );
    render(<App />);
    await screen.findByRole("heading", { level: 1, name: "A: All systems operational" });
    expect(
      screen.getByText("No data: information for this day is unavailable"),
    ).toBeInTheDocument();
    expect(screen.getByText("Each bar is one UTC day.")).toBeInTheDocument();
  });
});

describe("focus after navigation with body freshness", () => {
  it("still lands on the settled h1", async () => {
    const user = userEvent.setup();
    serve([productBody("a", "A")]);
    server.use(
      http.get("http://api.test/api/v1/products/a", () =>
        HttpResponse.json({
          ...productBody("a", "A"),
          generated_at: iso(ago(0)),
          region_details: [],
          incidents: [],
        }),
      ),
    );
    render(<App />);
    await user.click(await screen.findByRole("link", { name: "A" }));
    await waitFor(() => {
      expect(screen.getByRole("heading", { level: 1 })).toHaveFocus();
    });
    expect(screen.getByRole("heading", { level: 1 })).toHaveAccessibleName(
      "A: All systems operational",
    );
  });
});
