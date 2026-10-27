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

import type {
  Day,
  Extent,
  Incident,
  ProductFreshness,
  ProductSummary,
  RegionSummary,
  Status,
} from "../api/types";

/** A server time `msAgo` before now, floored to the minute as the API sends it. */
export function apiTime(msAgo = 0): Date {
  const t = new Date(Date.now() - msAgo);
  t.setUTCSeconds(0, 0);
  return t;
}

/** Every kind of data checked at `at` (default: this minute) and current. */
export function current(at: Date = apiTime()): ProductFreshness {
  return {
    checkedAt: { components: at, incidents: at, uptime: at },
    stale: { components: false, incidents: false, uptime: false },
  };
}

/** The wire form of current(): checked_at and stale as the API sends them. */
export function currentBody(at: Date = apiTime()): Record<string, unknown> {
  const iso = at.toISOString();
  return {
    checked_at: { components: iso, incidents: iso, uptime: iso },
    stale: { components: false, incidents: false, uptime: false },
  };
}

export function days(count: number, overrides: Record<number, Partial<Day>> = {}): Day[] {
  const start = Date.UTC(2026, 9, 20) - (count - 1) * 86_400_000;
  return Array.from({ length: count }, (_, i) => ({
    date: new Date(start + i * 86_400_000).toISOString().slice(0, 10),
    status: "operational",
    minutes: {},
    incidentIds: [],
    ...overrides[i],
  }));
}

/** "all" when every status is the rolled-up one, as statusd computes a product's extent. */
export function extentOf(rolled: Status, statuses: readonly Status[]): Extent {
  return statuses.length > 0 && statuses.every((s) => s === rolled) ? "all" : "some";
}

export function product(overrides: Partial<ProductSummary> = {}): ProductSummary {
  const made: Omit<ProductSummary, "extent"> = {
    id: "api-platform",
    name: "API Platform",
    status: "operational",
    dataComplete: true,
    freshness: current(),
    locations: [],
    regions: [
      {
        id: "us",
        name: "US",
        status: "operational",
        uptime: [],
      },
      {
        id: "eu",
        name: "EU",
        status: "operational",
        uptime: [],
      },
    ],
    history: days(90),
    ...overrides,
  };
  return {
    ...made,
    extent:
      overrides.extent ??
      extentOf(
        made.status,
        made.regions.map((r) => r.status),
      ),
  };
}

/** A part of a place, as the API lists it: "EU data plane" in location "eu", with a 90-day figure. */
export function part(name: string, status: Status = "operational", percent = 100): RegionSummary {
  return {
    id: name.toLowerCase().replaceAll(" ", "-"),
    name,
    status,
    uptime: [
      { window: "7d", percent: 100 },
      { window: "90d", percent },
    ],
    location: name.slice(0, 2).toLowerCase(),
  };
}

/** API Platform as configured: US and EU, each a control and a data plane. */
export function locatedProduct(overrides: Partial<ProductSummary> = {}): ProductSummary {
  return product({
    locations: [
      { id: "us", name: "US", status: "operational" },
      { id: "eu", name: "EU", status: "operational" },
    ],
    regions: [
      part("US control plane", "operational", 99.994),
      part("US data plane"),
      part("EU control plane"),
      part("EU data plane"),
    ],
    ...overrides,
  });
}

export function incident(overrides: Partial<Incident> = {}): Incident {
  return {
    id: "inc-1",
    productId: "api-platform",
    title: "Elevated latency",
    impact: "degraded",
    state: "resolved",
    startedAt: new Date("2026-10-20T08:00:00Z"),
    resolvedAt: new Date("2026-10-20T09:30:00Z"),
    ...overrides,
  };
}

const RANK: Partial<Record<string, number>> = {
  operational: 1,
  maintenance: 2,
  degraded: 3,
  outage: 4,
};

/**
 * The summary status as statusd computes it from wire-format products: the
 * worst known status, or unknown when data is missing and no problem is known.
 */
export function apiStatus(products: readonly unknown[]): string {
  let worst = "unknown";
  let complete = products.length > 0;
  for (const p of products as { status?: string; data_complete?: boolean }[]) {
    const status = p.status ?? "unknown";
    if ((RANK[status] ?? 0) > (RANK[worst] ?? 0)) worst = status;
    complete = complete && p.data_complete === true && status !== "unknown";
  }
  return !complete && (RANK[worst] ?? 0) <= 1 ? "unknown" : worst;
}

/** A wire-format summary body, every time this minute; the status follows the products. */
export function summaryBody(
  overrides: {
    status?: string;
    data_complete?: boolean;
    generated_at?: string;
    products?: unknown[];
    active_incidents?: unknown[];
  } = {},
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    data_complete: true,
    generated_at: apiTime().toISOString(),
    products: [
      {
        id: "api-platform",
        name: "API Platform",
        description: "Bijira",
        status: "operational",
        affected_regions: 0,
        data_complete: true,
        outdated: false,
        ...currentBody(),
        locations: [],
        regions: [
          {
            id: "us",
            name: "US",
            status: "operational",
          },
        ],
        history: [{ date: "2026-10-20", status: "operational" }],
      },
    ],
    active_incidents: [],
    ...overrides,
  };
  return { status: apiStatus(body.products as unknown[]), ...body };
}
