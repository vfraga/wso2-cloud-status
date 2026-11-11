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
import { http, HttpResponse } from "msw";
import { describe, expect, it, vi } from "vitest";
import { App } from "./App";
import { degradedSummary, expectTitle, mockApi, serve, server } from "./test/app";
import { apiTime, currentBody, summaryBody } from "./test/factories";

mockApi();

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
