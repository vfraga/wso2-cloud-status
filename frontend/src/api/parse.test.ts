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

import { describe, expect, it } from "vitest";
import { parseProductDetail, parseSummary, toStatus } from "./parse";
import { summaryBody } from "../test/factories";

describe("toStatus", () => {
  it("keeps known statuses and maps the rest to unknown", () => {
    expect(toStatus("outage")).toBe("outage");
    expect(toStatus("on-fire")).toBe("unknown");
    expect(toStatus(7)).toBe("unknown");
  });
});

describe("parseSummary", () => {
  it("reads a well-formed body", () => {
    const s = parseSummary(summaryBody());
    expect(s.status).toBe("operational");
    expect(s.products[0]).toMatchObject({
      id: "api-platform",
      description: "Bijira",
      dataComplete: true,
      freshness: { stale: { components: false, incidents: false, uptime: false } },
    });
    expect(s.products[0]?.history).toHaveLength(1);
  });

  it("survives garbage", () => {
    expect(parseSummary(null)).toEqual({
      status: "unknown",
      extent: "all",
      dataComplete: false,
      products: [],
      activeIncidents: [],
    });
    expect(parseSummary("nope").products).toEqual([]);
    expect(parseSummary({ products: [1, null, { name: "no id" }] }).products).toEqual([]);
  });

  it("omits a missing description and tolerates missing optional fields", () => {
    const s = parseSummary({
      status: "weird",
      products: [
        { id: "x", regions: [{ id: "r" }, { name: "no id" }], history: [{ date: "bad" }] },
      ],
      active_incidents: [{ id: "i", started_at: "not a date" }],
    });
    const p = s.products[0];
    expect(s.status).toBe("unknown");
    expect(p).toBeDefined();
    expect(p).not.toHaveProperty("description");
    expect(p?.name).toBe("x");
    expect(p?.regions).toEqual([{ id: "r", name: "r", status: "unknown", uptime: [] }]);
    expect(p?.locations).toEqual([]);
    expect(p?.history).toEqual([]);
    expect(s.activeIncidents).toEqual([]);
  });

  it("fails closed on data_complete: missing, contradicted, dropped or empty is incomplete", () => {
    const body = (summaryComplete: unknown, productComplete: boolean, status = "operational") => {
      const product = {
        ...(summaryBody().products as Record<string, unknown>[])[0],
        data_complete: productComplete,
        status,
      };
      return parseSummary({
        ...summaryBody({ products: [product] }),
        data_complete: summaryComplete,
      }).dataComplete;
    };
    expect(body(true, true)).toBe(true);
    expect(body(false, true)).toBe(false);
    expect(body(undefined, true)).toBe(false);
    expect(body("true", true)).toBe(false);
    // A known status is required too, and the products win over a contradicting flag.
    expect(body(true, true, "unknown")).toBe(false);
    expect(body(true, false)).toBe(false);
    // An empty list, or a product record that could not be read, is not complete.
    expect(parseSummary(summaryBody({ products: [] })).dataComplete).toBe(false);
    const ok = (summaryBody().products as Record<string, unknown>[])[0];
    const dropped = parseSummary(
      summaryBody({ products: [ok, { name: "B", status: "outage" }, "junk"] }),
    );
    expect(dropped.products).toHaveLength(1);
    expect(dropped.dataComplete).toBe(false);
  });

  it("reads a product as complete only when the API says so and every region is known", () => {
    const complete = (product: Record<string, unknown>) =>
      parseSummary(summaryBody({ products: [product] })).products[0]?.dataComplete;
    const ok = (summaryBody().products as Record<string, unknown>[])[0] ?? {};
    expect(complete(ok)).toBe(true);
    const withoutField = Object.fromEntries(
      Object.entries(ok).filter(([key]) => key !== "data_complete"),
    );
    expect(complete(withoutField)).toBe(false);
    const region = { id: "eu", name: "EU", status: "unknown" };
    expect(complete({ ...ok, regions: [region] })).toBe(false);
    // A region record without an id is dropped, and the product is then incomplete.
    expect(complete({ ...ok, regions: [{ name: "no id", status: "operational" }] })).toBe(false);
    // A record without its lists, or with a location it could not read, is not complete.
    const without = (key: string) =>
      Object.fromEntries(Object.entries(ok).filter(([k]) => k !== key));
    expect(complete(without("regions"))).toBe(false);
    expect(complete(without("locations"))).toBe(false);
    expect(complete({ ...ok, locations: [{ name: "no id" }] })).toBe(false);
  });

  it("reads checked_at and stale per kind, failing closed", () => {
    const ok = (summaryBody().products as Record<string, unknown>[])[0] ?? {};
    const read = (extra: Record<string, unknown>) =>
      parseSummary(summaryBody({ products: [{ ...ok, ...extra }] })).products[0]?.freshness;
    expect(
      read({
        checked_at: {
          components: "2026-10-21T14:05:00Z",
          incidents: "2026-10-21T13:00:00Z",
          uptime: null,
        },
        stale: { components: false, incidents: true, uptime: true },
      }),
    ).toEqual({
      checkedAt: {
        components: new Date("2026-10-21T14:05:00Z"),
        incidents: new Date("2026-10-21T13:00:00Z"),
        uptime: null,
      },
      stale: { components: false, incidents: true, uptime: true },
    });
    // A null or unreadable time is stale whatever the flag says, and so is a
    // kind whose flag is missing or not a boolean.
    expect(
      read({
        checked_at: {
          components: "soon",
          incidents: "2026-10-21T13:00:00Z",
          uptime: "2026-10-21T13:00:00Z",
        },
        stale: { components: false, incidents: "false" },
      })?.stale,
    ).toEqual({ components: true, incidents: true, uptime: true });
    // A product without checked_at and stale: every kind stale, no time to name.
    const bare = Object.fromEntries(
      Object.entries(ok).filter(([key]) => key !== "checked_at" && key !== "stale"),
    );
    expect(parseSummary(summaryBody({ products: [bare] })).products[0]?.freshness).toEqual({
      checkedAt: { components: null, incidents: null, uptime: null },
      stale: { components: true, incidents: true, uptime: true },
    });
  });

  it("parses an active incident", () => {
    const s = parseSummary(
      summaryBody({
        active_incidents: [
          {
            id: "i",
            product_id: "p",
            title: "T",
            impact: "outage",
            state: "investigating",
            started_at: "2026-10-20T08:00:00Z",
            resolved_at: null,
          },
        ],
      }),
    );
    expect(s.activeIncidents[0]).toMatchObject({ impact: "outage", resolvedAt: null });
  });

  it("reads an unreadable active incident as its product's incidents not received", () => {
    const ok = (summaryBody().products as Record<string, unknown>[])[0] ?? {};
    const other = { ...ok, id: "moesif", name: "Moesif" };
    const stale = (active: unknown) =>
      parseSummary(
        summaryBody({ products: [ok, other], active_incidents: active as unknown[] }),
      ).products.map((p) => [p.id, p.freshness.stale.incidents, p.freshness.checkedAt.incidents]);
    expect(stale([])).toEqual([
      ["api-platform", false, expect.any(Date)],
      ["moesif", false, expect.any(Date)],
    ]);
    // A start time that cannot be read: its product only.
    expect(stale([{ id: "i", product_id: "moesif", started_at: "22/10/2026 23:21" }])).toEqual([
      ["api-platform", false, expect.any(Date)],
      ["moesif", true, null],
    ]);
    // No product to blame, or no list at all: every product.
    for (const active of [["junk"], undefined]) {
      expect(stale(active).map(([, isStale]) => isStale)).toEqual([true, true]);
    }
  });

  it("skips a history day that is not a calendar day", () => {
    const ok = (summaryBody().products as Record<string, unknown>[])[0] ?? {};
    const history = ["2026-10-20", "2026-13-45", "2026-02-30", "2026-00-10", "bad"].map((date) => ({
      date,
      status: "operational",
    }));
    const s = parseSummary(summaryBody({ products: [{ ...ok, history }] }));
    expect(s.products[0]?.history.map((d) => d.date)).toEqual(["2026-10-20"]);
  });
});

describe("parseProductDetail", () => {
  it("reads a product's unreadable incidents as not received", () => {
    const ok = (summaryBody().products as Record<string, unknown>[])[0] ?? {};
    const good = { id: "a", product_id: "api-platform", started_at: "2026-10-20T08:00:00Z" };
    const read = (incidents: unknown) => parseProductDetail({ ...ok, incidents });
    expect(read([good])?.freshness.stale.incidents).toBe(false);
    for (const incidents of [undefined, "none", [good, { id: "b" }]]) {
      const detail = read(incidents);
      expect(detail?.freshness.stale.incidents).toBe(true);
      expect(detail?.freshness.checkedAt.incidents).toBeNull();
      // Components and uptime keep their own freshness.
      expect(detail?.freshness.stale.components).toBe(false);
    }
    // The readable ones are kept, so the page can say the list is incomplete.
    expect(read([good, { id: "b" }])?.incidents.map((i) => i.id)).toEqual(["a"]);
  });

  it("reads groups, components and uptime", () => {
    const detail = parseProductDetail({
      ...(summaryBody().products as Record<string, unknown>[])[0],
      region_details: [
        {
          id: "us",
          name: "US",
          status: "degraded",
          uptime: [
            { window: "7d", percent: 99.5 },
            { window: "bad", percent: "x" },
          ],
          groups: [
            {
              name: "Dev",
              status: "degraded",
              components: [
                {
                  name: "Build",
                  status: "degraded",
                  message: "slow",
                  description: "d",
                  uptime: [{ window: "30d", percent: 100 }],
                },
                {},
              ],
            },
          ],
        },
        { name: "no id" },
      ],
      incidents: [],
    });
    expect(detail?.regionDetails).toHaveLength(1);
    const region = detail?.regionDetails[0];
    expect(region?.uptime).toEqual([{ window: "7d", percent: 99.5 }]);
    expect(region?.groups[0]?.components[0]).toMatchObject({ message: "slow", description: "d" });
    expect(region?.groups[0]?.components[1]?.name).toBe("Unnamed component");
  });

  it("returns null for a malformed product", () => {
    expect(parseProductDetail(null)).toBeNull();
    expect(parseProductDetail({})).toBeNull();
  });
});
