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

import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { App } from "../App";
import { forgetListedProducts } from "../lib/fallbackProducts";
import { formatMonthHeading, localMonthStart } from "../lib/time";
import { apiTime, incident } from "../test/factories";
import { historyMonths } from "./HistoryPage";

const server = setupServer();
beforeAll(() => {
  server.listen({ onUnhandledFrame: "error" });
});
afterEach(() => {
  server.resetHandlers();
  forgetListedProducts();
});
afterAll(() => {
  server.close();
});
beforeEach(() => {
  window.history.pushState(null, "", "/history");
});

const monthsAgo = (n: number): Date => {
  const now = apiTime();
  return new Date(now.getFullYear(), now.getMonth() - n, 15, 12);
};

function listBody(overrides: Record<string, unknown> = {}) {
  const now = apiTime();
  const checked = new Date(Math.floor(now.getTime() / 60_000) * 60_000).toISOString();
  const coveredFrom = localMonthStart(monthsAgo(2)).toISOString();
  return {
    generated_at: checked,
    products: [
      {
        id: "api-platform",
        name: "API Platform",
        covered_from: coveredFrom,
        checked_at: checked,
        stale: false,
      },
      {
        id: "moesif",
        name: "Moesif",
        covered_from: coveredFrom,
        checked_at: checked,
        stale: false,
      },
    ],
    incidents: [
      {
        id: "old",
        product_id: "api-platform",
        title: "Old gateway errors",
        impact: "outage",
        state: "resolved",
        started_at: monthsAgo(2).toISOString(),
        resolved_at: new Date(monthsAgo(2).getTime() + 3_600_000).toISOString(),
      },
      {
        id: "moesif-1",
        product_id: "moesif",
        title: "Delayed analytics",
        impact: "degraded",
        state: "resolved",
        started_at: monthsAgo(1).toISOString(),
        resolved_at: new Date(monthsAgo(1).getTime() + 1_800_000).toISOString(),
      },
    ],
    ...overrides,
  };
}

function serve(body: Record<string, unknown>) {
  server.use(http.get("http://api.test/api/v1/incidents", () => HttpResponse.json(body)));
}

describe("historyMonths", () => {
  const now = new Date(2026, 9, 27, 12);

  it("lists every covered month, quiet or not, newest first", () => {
    const months = historyMonths(
      [incident({ startedAt: new Date(2026, 8, 3) })],
      new Date(2026, 7, 1),
      null,
      now,
    );
    expect(months.map((m) => [m.key, m.incidents.length])).toEqual([
      ["2026-10", 0],
      ["2026-09", 1],
      ["2026-08", 0],
    ]);
  });

  it("does not call a month quiet that the data covers only in part", () => {
    const partial = historyMonths([], new Date(2026, 7, 2), null, now);
    expect(partial.map((m) => m.key)).toEqual(["2026-10", "2026-09"]);
    // A feed that stopped on Oct 5: October cannot be vouched for.
    const stopped = historyMonths([], new Date(2026, 7, 1), new Date(2026, 9, 5), now);
    expect(stopped.map((m) => m.key)).toEqual(["2026-09", "2026-08"]);
    // Without coverage, only the months that hold an incident.
    const unknown = historyMonths([incident({ startedAt: new Date(2026, 6, 9) })], null, null, now);
    expect(unknown.map((m) => m.key)).toEqual(["2026-07"]);
  });
});

describe("incident history page", () => {
  it("lists every product's incidents by month, each linking its product", async () => {
    serve(listBody());
    render(<App />);
    expect(
      await screen.findByRole("heading", { level: 1, name: "Incident history" }),
    ).toBeInTheDocument();
    const month = await screen.findByRole("region", { name: formatMonthHeading(monthsAgo(1)) });
    expect(within(month).getByText("Delayed analytics")).toBeInTheDocument();
    expect(within(month).getByRole("link", { name: "Moesif" })).toHaveAttribute(
      "href",
      "/products/moesif",
    );
    const quiet = screen.getByRole("region", { name: formatMonthHeading(apiTime()) });
    expect(within(quiet).getByText("No incidents reported.")).toBeInTheDocument();
    expect(
      screen.getByText(/^Incidents since .+ UTC, under the month each started/),
    ).toBeInTheDocument();
    expect(document.title).toBe("Incident history - WSO2 Cloud Status");
  });

  it("opens filtered to the product the address names, and the filter changes the address", async () => {
    const user = userEvent.setup();
    window.history.pushState(null, "", "/history?product=api-platform");
    serve(listBody());
    render(<App />);
    expect(await screen.findByText("Old gateway errors")).toBeInTheDocument();
    expect(screen.queryByText("Delayed analytics")).toBeNull();
    const filter = screen.getByRole("combobox", { name: "Product" });
    expect(filter).toHaveValue("api-platform");
    await user.selectOptions(filter, "");
    expect(window.location.pathname + window.location.search).toBe("/history");
    expect(await screen.findByText("Delayed analytics")).toBeInTheDocument();
  });

  it("names a product whose incidents are incomplete and calls no month quiet for it", async () => {
    window.history.pushState(null, "", "/history?product=moesif");
    const body = listBody();
    serve({
      ...body,
      products: body.products.map((p) =>
        p.id === "moesif" ? { ...p, covered_from: null, checked_at: null, stale: true } : p,
      ),
    });
    render(<App />);
    expect(
      await screen.findByText("Incident information for Moesif is incomplete right now."),
    ).toBeInTheDocument();
    expect(screen.queryByText("No incidents reported.")).toBeNull();
    expect(screen.getByText("Delayed analytics")).toBeInTheDocument();
  });

  it("says so when the list cannot be loaded", async () => {
    server.use(
      http.get("http://api.test/api/v1/incidents", () => new HttpResponse(null, { status: 503 })),
    );
    render(<App />);
    expect(
      await screen.findByText("Incident history is not available right now."),
    ).toBeInTheDocument();
  });
});
