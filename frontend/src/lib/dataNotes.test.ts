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
import type { PerKind, ProductFreshness, ProductSummary } from "../api/types";
import { days, incident, product } from "../test/factories";
import {
  bannerFreshness,
  completeUntil,
  componentNotes,
  incidentFeedsLine,
  lastKnownAt,
  missingIncidents,
  staleFeedLines,
} from "./dataNotes";
import { componentFreshness, freshness, incidentCoverage } from "./freshness";
import { dayAriaLabel, dayDetail } from "./history";
import { formatHistoryDate, formatUtcClock, formatUtcDateTime, formatUtcTime } from "./time";

const now = new Date("2026-10-21T14:17:30Z");
const at = (hhmm: string, date = "2026-10-21") => new Date(`${date}T${hhmm}:00Z`);

function fresh(
  checkedAt: Partial<PerKind<Date | null>> = {},
  stale: Partial<PerKind<boolean>> = {},
): ProductFreshness {
  return {
    checkedAt: {
      components: at("14:17"),
      incidents: at("14:17"),
      uptime: at("14:10"),
      ...checkedAt,
    },
    stale: { components: false, incidents: false, uptime: false, ...stale },
  };
}

const named = (name: string, overrides: Partial<ProductSummary> = {}): ProductSummary =>
  product({ id: name.toLowerCase(), name, freshness: fresh(), ...overrides });

describe("time formats for data freshness", () => {
  it("writes UTC times, with the date only when it is not today", () => {
    expect(formatUtcClock(at("09:05"))).toMatch(/^0?9:05 /);
    expect(formatUtcClock(at("09:05")).endsWith(" UTC")).toBe(true);
    expect(formatUtcDateTime(at("14:05"))).toContain(formatHistoryDate("2026-10-21"));
    expect(formatUtcDateTime(at("14:05"))).toContain(formatUtcClock(at("14:05")));
    expect(formatUtcTime(at("14:05"), now)).toBe(formatUtcClock(at("14:05")));
    expect(formatUtcTime(at("23:55", "2026-10-20"), now)).toBe(
      formatUtcDateTime(at("23:55", "2026-10-20")),
    );
  });
});

describe("componentFreshness", () => {
  it("dates the page by the current products and lists the late ones", () => {
    const result = componentFreshness([
      named("A", { freshness: fresh({ components: at("14:16") }) }),
      named("B", { freshness: fresh({ components: at("14:15") }) }),
      named("Moesif", {
        status: "unknown",
        freshness: fresh({ components: at("12:00") }, { components: true }),
      }),
      named("Dev", { freshness: fresh({ components: null }, { components: true }) }),
    ]);
    expect(result).toEqual({
      checkedAt: at("14:15"),
      late: [
        { name: "Moesif", partly: false, at: at("12:00") },
        { name: "Dev", partly: true, at: null },
      ],
    });
  });

  it("has no page time when nothing is current or there are no products", () => {
    expect(
      componentFreshness([
        named("A", {
          status: "unknown",
          freshness: fresh({ components: null }, { components: true }),
        }),
      ]).checkedAt,
    ).toBeNull();
    // A current check on a product whose status is unknown does not date the page.
    expect(componentFreshness([named("A", { status: "unknown" })])).toEqual({
      checkedAt: null,
      late: [],
    });
    expect(componentFreshness([])).toEqual({ checkedAt: null, late: [] });
  });
});

describe("freshness without a check time", () => {
  it("shows no age and is not outdated until a refresh fails", () => {
    const inputs = { checkedAt: null, lastSuccessAt: new Date(), failed: false };
    expect(freshness(new Date(), inputs)).toEqual({
      ageMs: null,
      outdated: false,
      unavailable: false,
    });
    expect(freshness(new Date(), { ...inputs, failed: true }).outdated).toBe(true);
  });
});

describe("freshness of a check time ahead of the server's clock", () => {
  it("never reads it as a negative age", () => {
    const now = new Date("2026-10-21T14:17:30Z");
    expect(
      freshness(now, { checkedAt: at("14:18"), lastSuccessAt: now, failed: false }).ageMs,
    ).toBe(0);
  });
});

describe("incident coverage", () => {
  it("is current, never answered, or complete until the last fetch", () => {
    expect(incidentCoverage(named("A"))).toEqual({ state: "current" });
    expect(
      incidentCoverage(named("A", { freshness: fresh({ incidents: null }, { incidents: true }) })),
    ).toEqual({ state: "never" });
    expect(
      incidentCoverage(
        named("A", { freshness: fresh({ incidents: at("14:05") }, { incidents: true }) }),
      ),
    ).toEqual({ state: "until", at: at("14:05") });
  });
});

describe("notes on late data", () => {
  const stopped = named("Moesif", {
    freshness: fresh({ incidents: at("14:05") }, { incidents: true }),
  });
  const never = named("Agent", { freshness: fresh({ incidents: null }, { incidents: true }) });

  it("groups late component data by wording and time", () => {
    expect(
      componentNotes(
        [
          { name: "A", partly: false, at: null },
          { name: "B", partly: false, at: null },
          { name: "C", partly: true, at: null },
          { name: "D", partly: false, at: at("12:00") },
          { name: "E", partly: false, at: at("12:00") },
          { name: "F", partly: true, at: at("23:00", "2026-10-20") },
        ],
        now,
      ),
    ).toEqual([
      "No status data has been received yet for A and B.",
      "Some status data has not been received yet for C.",
      `Status data for D and E was last checked at ${formatUtcClock(at("12:00"))}.`,
      `Some status data for F was last checked at ${formatUtcDateTime(at("23:00", "2026-10-20"))}.`,
    ]);
  });

  it("names incident feeds that stopped or never answered, never a product already named as unavailable", () => {
    const time = formatUtcClock(at("14:05"));
    expect(incidentFeedsLine([named("A"), stopped, never], [], now)).toBe(
      `Incident information for Moesif has not been updated since ${time}. ` +
        "Incident information for Agent is unavailable right now.",
    );
    // Another of Agent's sources answered: incomplete, not unavailable.
    expect(incidentFeedsLine([never], [incident({ productId: "agent" })], now)).toBe(
      "Incident information for Agent is incomplete right now.",
    );
    // Products with the same wording and time share one sentence.
    const other = named("Dev", { freshness: stopped.freshness });
    const silent = named("Idp", { freshness: never.freshness });
    expect(incidentFeedsLine([stopped, never, other, silent], [], now)).toBe(
      `Incident information for Moesif and Dev has not been updated since ${time}. ` +
        "Incident information for Agent and Idp is unavailable right now.",
    );
    expect(incidentFeedsLine([{ ...stopped, status: "unknown" }], [], now)).toBeUndefined();
    expect(incidentFeedsLine([{ ...never, status: "unknown" }], [], now)).toBeUndefined();
    expect(incidentFeedsLine([named("A")], [], now)).toBeUndefined();
    expect(completeUntil(stopped)).toEqual(at("14:05"));
    expect(completeUntil(never)).toBeNull();
  });

  it("knows when an ongoing incident of a stopped feed was last known", () => {
    const open = incident({ productId: "moesif", resolvedAt: null });
    expect(lastKnownAt(open, stopped)).toEqual(at("14:05"));
    expect(lastKnownAt(incident(), stopped)).toBeNull();
    expect(lastKnownAt(open, never)).toBeNull();
    expect(lastKnownAt(open, undefined)).toBeNull();
  });

  it("states when each stale feed was last updated, or that it never answered", () => {
    const both = named("A", {
      freshness: fresh(
        { incidents: at("14:05"), uptime: at("11:17") },
        { incidents: true, uptime: true },
      ),
    });
    expect(staleFeedLines(both, now)).toEqual([
      `Incidents last updated ${formatUtcClock(at("14:05"))} (12 min ago)`,
      `Uptime last updated ${formatUtcClock(at("11:17"))} (3 hours ago)`,
    ]);
    expect(
      staleFeedLines(
        named("A", {
          freshness: fresh({ incidents: null, uptime: null }, { incidents: true, uptime: true }),
        }),
        now,
      ),
    ).toEqual(["Incident information unavailable", "Uptime unavailable"]);
    // Another source's data of that kind is shown: incomplete, not unavailable.
    expect(
      staleFeedLines(
        named("A", {
          freshness: fresh({ incidents: null, uptime: null }, { incidents: true, uptime: true }),
        }),
        now,
        { incidents: true, uptime: true },
      ),
    ).toEqual(["Incident information incomplete", "Uptime incomplete"]);
    expect(staleFeedLines(named("A"), now)).toEqual([]);
  });

  it("knows which products' incident data is not complete", () => {
    const missing = missingIncidents(
      [named("A"), stopped, never],
      [incident({ productId: "agent" })],
    );
    expect(missing.map((m) => [m.product.name, m.coverage.state, m.partly])).toEqual([
      ["Moesif", "until", false],
      ["Agent", "never", true],
    ]);
  });

  it("says the day that contains the last fetch is complete only until then", () => {
    const today = days(1, { 0: { date: "2026-10-21" } })[0]!;
    const detail = dayDetail(today, new Map(), now, at("14:05"));
    const until = `Incident information complete only until ${formatUtcClock(at("14:05"))}.`;
    expect(detail.note).toBe(until);
    expect(dayAriaLabel(detail).endsWith(`No incidents. ${until}`)).toBe(true);
    expect(dayDetail(today, new Map(), now, at("14:05", "2026-10-20")).note).toBeNull();
    expect(dayDetail(today, new Map(), now).note).toBeNull();
  });
});

describe("bannerFreshness", () => {
  const state = { lastSuccessAt: now, failed: false, staleOnArrival: false, skewMs: 0 };

  it("dates the page by the products' component checks", () => {
    expect(bannerFreshness(state, [named("A")], [], now)).toEqual({
      checkedAt: at("14:17"),
      notes: [],
      someLate: false,
      lastSuccessAt: now,
      failed: false,
      servedStale: false,
      skewMs: 0,
    });
    // An old snapshot is an old copy whatever the products' own checks say.
    expect(
      bannerFreshness({ ...state, staleOnArrival: true }, [named("A")], [], now).servedStale,
    ).toBe(true);
  });

  it("has no age and no secondary line without products", () => {
    const none = bannerFreshness(state, null, [], now);
    expect(none.checkedAt).toBeNull();
    expect(none).not.toHaveProperty("secondary");
    expect(bannerFreshness(state, [], [], now).checkedAt).toBeNull();
  });
});
