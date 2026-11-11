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

import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { describe, expect, it, vi } from "vitest";
import { App } from "./App";
import { UPTIME_NOTE } from "./lib/status";
import { formatDayHeading } from "./lib/time";
import { expectTitle, mockApi, productDetail as detail, serve, server } from "./test/app";
import { apiTime, currentBody, summaryBody } from "./test/factories";

mockApi();

describe("product page", () => {
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
    // 19 when a minute turns between the page's clock (taken at mount) and
    // the answer's times (floored when the handler runs).
    expect(
      screen.getByText(/^Incidents last updated .+ UTC \((19|2\d) min ago\)$/),
    ).toBeInTheDocument();
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

  it("names no span over Recent incidents when the product sends no history days", async () => {
    window.history.pushState(null, "", "/products/api-platform");
    server.use(
      http.get("http://api.test/api/v1/products/api-platform", () =>
        HttpResponse.json({ ...detail(), ...currentBody(), history: [] }),
      ),
    );
    render(<App />);
    const recent = await screen.findByRole("region", { name: "Recent incidents" });
    expect(within(recent).queryByText(/The last/)).toBeNull();
    expect(within(recent).getByRole("link", { name: "Older incidents" })).toBeInTheDocument();
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
});
