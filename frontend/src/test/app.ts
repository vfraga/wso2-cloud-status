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

import { screen, waitFor } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, beforeEach, expect, vi } from "vitest";
import { forgetListedProducts } from "../lib/fallbackProducts";
import { apiTime, currentBody, summaryBody } from "./factories";

/** The mock API the whole app is rendered against. */
export const server = setupServer();
// Neither page asks for the incident list: the home page takes active
// incidents from the summary, and a product's page has its own.
const incidentListRequests: string[] = [];
server.events.on("request:start", ({ request }) => {
  if (new URL(request.url).pathname === "/api/v1/incidents") incidentListRequests.push(request.url);
});

/**
 * Runs the mock API for the calling file's tests, each starting on the home
 * page, and fails a test that asked for the incident list.
 */
export function mockApi(): void {
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
}

/** Incidents last read 20 minutes ago: the feed is past its staleness. */
const incidentsStopped = () => {
  const now = apiTime().toISOString();
  return {
    outdated: true,
    checked_at: { components: now, incidents: apiTime(20 * 60_000).toISOString(), uptime: now },
    stale: { components: false, incidents: true, uptime: false },
  };
};

/** API Platform degraded in EU with one active incident; Moesif's incident feed stopped. */
export function degradedSummary() {
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

/** API Platform's product body: degraded in EU, its incident feed stopped. */
export const productDetail = () => ({
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

/**
 * Focus moves in an effect that runs after the h1 is in the document, so this
 * waits for the focus, not for the h1 (on a slow machine the two are apart).
 */
export async function expectHeadingFocused(name: string): Promise<void> {
  await waitFor(() => {
    expect(screen.getByRole("heading", { level: 1, name })).toHaveFocus();
  });
}

/** The title is set in an effect after the view renders, so this waits for it. */
export async function expectTitle(title: string): Promise<void> {
  await waitFor(() => {
    expect(document.title).toBe(title);
  });
}

/** `summary` is a body, or a function that builds one per request (times move with the clock). */
export function serve(summary: unknown) {
  const body = (): unknown =>
    typeof summary === "function" ? (summary as () => unknown)() : summary;
  server.use(
    http.get("http://api.test/api/v1/summary", () =>
      HttpResponse.json(body() as Record<string, unknown>),
    ),
  );
}
