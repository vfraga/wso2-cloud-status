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
import type { Day } from "../api/types";
import { clockSkew, freshness, staleOnArrival } from "./freshness";
import {
  coveredDays,
  dayAriaLabel,
  dayDetail,
  historyText,
  stripCaptions,
  summariseHistory,
} from "./history";
import { incidentDuration, isOngoing, stateLabel, worstImpact } from "./incidents";
import {
  formatCheckAge,
  formatDuration,
  formatHistoryDate,
  formatMinutes,
  formatClock,
  formatUtcClock,
  formatUtcDateTime,
  utcDayKey,
} from "./time";
import { days, incident, locatedProduct, part, product } from "../test/factories";
import { placeNames, placeStatus, productRows, regionRows, rowStatus, shortName } from "./regions";

describe("formatDuration", () => {
  it.each([
    [30_000, "under 1m"],
    [45 * 60_000, "45m"],
    [60 * 60_000, "1h"],
    [72 * 60_000, "1h 12m"],
    [27 * 3_600_000, "1d 3h"],
    [48 * 3_600_000, "2d"],
    [-5, "under 1m"],
  ])("%d ms is %s", (ms, text) => {
    expect(formatDuration(ms)).toBe(text);
  });
});

describe("formatCheckAge", () => {
  // Outdated: whole units since the start of the reported minute.
  it.each([
    [-5_000, "just now"],
    [59_000, "just now"],
    [60_000, "1 min ago"],
    [180_000, "3 min ago"],
    [3_600_000, "1 hour ago"],
    [2 * 3_600_000, "2 hours ago"],
    [86_400_000, "1 day ago"],
    [3 * 86_400_000, "3 days ago"],
  ])("%d ms outdated reads %s", (ms, text) => {
    expect(formatCheckAge(ms, true)).toBe(text);
  });

  // Current: from the end of the reported minute, so a fresh load reads "just now".
  it.each([
    [-5_000, "just now"],
    [119_999, "just now"],
    [120_000, "1 min ago"],
    [5 * 60_000, "4 min ago"],
    [61 * 60_000, "1 hour ago"],
  ])("%d ms current reads %s", (ms, text) => {
    expect(formatCheckAge(ms, false)).toBe(text);
  });
});

describe("formatMinutes", () => {
  it.each([
    [5 * 60_000, "5 minutes"],
    [60_000, "1 minute"],
    [90_000, "2 minutes"],
    [10_000, "1 minute"],
  ])("%d ms reads %s", (ms, text) => {
    expect(formatMinutes(ms)).toBe(text);
  });
});

describe("dates", () => {
  it("writes UTC and local times with one hour cycle, and UTC dates in one style", () => {
    // A UTC instant and a local wall-clock time, both 14:05: only the zone differs.
    const utc = new Date(Date.UTC(2026, 9, 21, 14, 5));
    const local = new Date(2026, 9, 21, 14, 5);
    const withoutZone = (s: string): string => s.slice(0, s.lastIndexOf(" "));
    expect(formatUtcClock(utc)).toMatch(/ UTC$/);
    expect(withoutZone(formatUtcClock(utc))).toBe(withoutZone(formatClock(local)));
    expect(formatUtcDateTime(utc)).toContain(formatHistoryDate("2026-10-21"));
  });

  it("keys a UTC calendar day", () => {
    expect(utcDayKey(new Date("2026-10-20T23:59:59Z"))).toBe("2026-10-20");
    expect(utcDayKey(new Date("2026-10-21T00:00:00Z"))).toBe("2026-10-21");
  });
});

describe("freshness", () => {
  const now = new Date("2026-10-20T12:00:00Z");
  const at = (iso: string) => new Date(`2026-10-20T${iso}Z`);
  const f = (checkedAt: Date | null, lastSuccessAt: Date | null, failed: boolean) =>
    freshness(now, { checkedAt, lastSuccessAt, failed });

  it("measures the age of the check time", () => {
    expect(f(at("11:59:00"), at("11:59:50"), false)).toEqual({
      ageMs: 60_000,
      outdated: false,
      unavailable: false,
    });
    // Without a check time there is no age: the last fetch does not stand in for one.
    expect(f(null, at("11:59:30"), false).ageMs).toBeNull();
  });

  it("is outdated after five minutes or on failure", () => {
    expect(f(at("11:50:00"), null, false).outdated).toBe(true);
    expect(f(at("11:59:59"), null, true).outdated).toBe(true);
  });

  it("is unavailable when the latest attempt failed and the last success is too old", () => {
    const recent = at("11:59:00");
    expect(f(recent, at("11:55:00"), true)).toEqual({
      ageMs: 60_000,
      outdated: true,
      unavailable: false,
    });
    expect(f(recent, at("11:54:59"), true)).toEqual({
      ageMs: 60_000,
      outdated: true,
      unavailable: true,
    });
    // No failure yet, as in a tab back from the background: not unavailable.
    expect(f(at("11:40:00"), at("11:40:00"), false)).toEqual({
      ageMs: 20 * 60_000,
      outdated: true,
      unavailable: false,
    });
  });

  it("is unavailable for a response that was already too old on arrival, whatever the age now", () => {
    expect(
      freshness(now, {
        checkedAt: at("11:59:00"),
        lastSuccessAt: now,
        failed: false,
        servedStale: true,
      }),
    ).toEqual({ ageMs: 60_000, outdated: true, unavailable: true });
  });

  it("measures the server timestamp on the server's clock", () => {
    // This browser is 10 minutes ahead: the data is 30 s old, not 10.5 minutes.
    const ahead = freshness(new Date("2026-10-20T12:10:00Z"), {
      checkedAt: at("11:59:30"),
      lastSuccessAt: new Date("2026-10-20T12:10:00Z"),
      failed: false,
      skewMs: 10 * 60_000,
    });
    expect(ahead).toEqual({ ageMs: 30_000, outdated: false, unavailable: false });
    // The browser's own times stay on its own clock: 5 minutes 30 s since the
    // last success is past the limit, whatever the skew.
    expect(
      freshness(now, {
        checkedAt: at("11:59:30"),
        lastSuccessAt: at("11:54:30"),
        failed: true,
        skewMs: -60_000,
      }).unavailable,
    ).toBe(true);
  });

  it("measures skew from one response", () => {
    expect(clockSkew(at("12:10:00"), at("12:00:00"))).toBe(10 * 60_000);
    expect(clockSkew(at("11:50:00"), at("12:00:00"))).toBe(-10 * 60_000);
    expect(clockSkew(now, null)).toBe(0);
  });

  it("measures staleness on arrival against the limit", () => {
    expect(staleOnArrival(now, null)).toBe(false);
    expect(staleOnArrival(now, at("11:55:00"))).toBe(false);
    expect(staleOnArrival(now, at("11:54:59"))).toBe(true);
    // A clock behind the server's reads as fresh, never as negative age.
    expect(staleOnArrival(now, at("12:01:00"))).toBe(false);
  });

  it("has no age before data", () => {
    expect(f(null, null, false)).toEqual({ ageMs: null, outdated: false, unavailable: false });
    expect(f(null, null, true).unavailable).toBe(false);
  });
});

describe("incidents", () => {
  const now = new Date("2026-10-20T12:00:00Z");

  it("measures open incidents to now", () => {
    const open = incident({ resolvedAt: null, startedAt: new Date("2026-10-20T10:30:00Z") });
    expect(isOngoing(open)).toBe(true);
    expect(incidentDuration(open, now)).toBe(90 * 60_000);
  });

  it("labels states and picks the worst impact", () => {
    expect(stateLabel("investigating")).toBe("Investigating");
    expect(stateLabel("")).toBe("");
    expect(worstImpact([incident({ impact: "degraded" }), incident({ impact: "outage" })])).toBe(
      "outage",
    );
    expect(worstImpact([])).toBe("unknown");
  });
});

describe("history text", () => {
  it("summarises the strip", () => {
    const d = days(90, {
      3: { status: "degraded" },
      4: { status: "outage" },
      5: { status: "unknown" },
    });
    expect(summariseHistory(d)).toEqual({
      withIncidents: 2,
      withMaintenance: false,
      withoutData: 1,
    });
    expect(historyText(d)).toBe("90 days: 2 days with incidents, 1 day without data");
    expect(historyText(days(90, { 0: { status: "maintenance" } }))).toBe(
      // A maintenance-only day is not called an incident.
      "90 days: 1 day with incidents or maintenance, 0 days without data",
    );
  });

  it("builds a day label with minutes and titles", () => {
    const d = days(1, {
      0: {
        status: "outage",
        minutes: { outage: 62, degraded: 10 },
        incidentIds: ["inc-1", "gone"],
      },
    })[0]!;
    const detail = dayDetail(d, new Map([["inc-1", incident()]]), new Date("2026-10-21T00:00:00Z"));
    expect(detail.titles).toEqual(["Elevated latency"]);
    expect(dayAriaLabel(detail)).toBe(
      `${detail.heading}: Service outage. Service outage 1h 2m. Degraded performance 10m. Incidents: Elevated latency`,
    );
    expect(detail.heading).toBe(`${formatHistoryDate("2026-10-20")} (UTC)`);
    expect(formatHistoryDate("2026-10-20")).toMatch(/20/);
  });

  it("times a day from its incidents on the page's clock, so the strip and the list agree", () => {
    const now = new Date("2026-10-20T10:30:40Z");
    const open = incident({
      id: "open",
      impact: "unknown",
      startedAt: new Date("2026-10-20T09:00:00Z"),
      resolvedAt: null,
    });
    const overlap = incident({
      id: "overlap",
      impact: "degraded",
      startedAt: new Date("2026-10-20T08:30:00Z"),
      resolvedAt: new Date("2026-10-20T09:15:00Z"),
    });
    const outage = incident({
      id: "outage",
      impact: "outage",
      startedAt: new Date("2026-10-19T23:00:00Z"),
      resolvedAt: new Date("2026-10-20T00:20:30Z"),
    });
    const map = new Map([open, overlap, outage].map((i) => [i.id, i]));
    // The API rounded up when it built the day (1h 31m); the list floors (1h 30m).
    const day = days(1, {
      0: {
        status: "outage",
        minutes: { degraded: 121, outage: 21 },
        incidentIds: ["open", "overlap", "outage"],
      },
    })[0]!;
    const detail = dayDetail(day, map, now);
    // Degraded: 08:30 to 10:30:40, overlaps once, an unknown impact counting as degraded.
    // Outage: midnight to 00:20:30, the part of the incident on this UTC day.
    expect(detail.minutes).toEqual([
      { label: "Service outage", text: "20m" },
      { label: "Degraded performance", text: "2h" },
    ]);
    expect(formatDuration(incidentDuration(open, now))).toBe("1h 30m");
    // An incident not at hand, or one this clock places on another day: the API's minutes.
    const partial = { ...day, incidentIds: ["open", "missing"] };
    expect(dayDetail(partial, map, now).minutes[0]).toEqual({
      label: "Service outage",
      text: "21m",
    });
    expect(dayDetail(day, map, new Date("2026-10-20T00:10:00Z")).minutes[1]).toEqual({
      label: "Degraded performance",
      text: "2h 1m",
    });
  });

  it("times an open incident only up to the last fetch when its feed stopped", () => {
    const open = incident({
      id: "open",
      impact: "outage",
      startedAt: new Date("2026-10-20T08:00:00Z"),
      resolvedAt: null,
    });
    const day = days(1, {
      0: { status: "outage", minutes: { outage: 60 }, incidentIds: ["open"] },
    })[0]!;
    const now = new Date("2026-10-20T20:00:00Z");
    const map = new Map([["open", open]]);
    expect(dayDetail(day, map, now).minutes).toEqual([{ label: "Service outage", text: "12h" }]);
    expect(dayDetail(day, map, now, new Date("2026-10-20T09:15:00Z")).minutes).toEqual([
      { label: "Service outage", text: "1h 15m" },
    ]);
  });

  it("captions the strip with the first date and Today only for today's UTC date", () => {
    const d = days(30);
    const first = formatHistoryDate("2026-09-21");
    expect(stripCaptions(d, "2026-10-20")).toEqual([first, "Today"]);
    expect(stripCaptions(d, "2026-10-21")).toEqual([first, formatHistoryDate("2026-10-20")]);
    expect(stripCaptions([], "2026-10-20")).toEqual(["", ""]);
  });
});

describe("region rows", () => {
  it("groups parts under their place, in the API's order, and keeps the rest on their own", () => {
    const rows = productRows(locatedProduct());
    expect(rows.map((r) => (r.kind === "location" ? r.location.name : r.region.name))).toEqual([
      "US",
      "EU",
    ]);
    expect(rows[0]?.kind === "location" && rows[0].regions.map((r) => r.id)).toEqual([
      "us-control-plane",
      "us-data-plane",
    ]);
    const plain = productRows(locatedProduct({ locations: [] }));
    expect(plain.map((r) => r.kind)).toEqual(["region", "region", "region", "region"]);
    // A place without parts is not listed; a part whose place is unknown stands alone.
    const odd = regionRows(
      [
        { id: "us", name: "US", status: "degraded" },
        { id: "ap", name: "AP", status: "operational" },
      ],
      [part("US data plane", "degraded"), part("EU data plane")],
    );
    expect(odd.map((r) => [r.kind, rowStatus(r)])).toEqual([
      ["location", "degraded"],
      ["region", "operational"],
    ]);
  });

  it("names a part without its place, and leaves other names alone", () => {
    const eu = { id: "eu", name: "EU", status: "operational" as const };
    expect(shortName(part("EU data plane"), eu)).toBe("Data plane");
    expect(shortName(part("EU data plane (US-managed)"), eu)).toBe("Data plane (US-managed)");
    expect(shortName(part("Europe"), eu)).toBe("Europe");
    expect(shortName({ ...part("EU "), name: "EU " }, eu)).toBe("EU ");
  });

  it("lists every product's places once, in the API's order", () => {
    const usOnly = product({ id: "moesif", regions: product().regions.slice(0, 1) });
    expect(placeNames([usOnly, locatedProduct()])).toEqual(["US", "EU"]);
    expect(placeNames([product({ regions: [] })])).toEqual([]);
  });

  it("gives a place's own status, and names the parts that carry it only when they differ", () => {
    const degraded = locatedProduct({
      locations: [
        { id: "us", name: "US", status: "operational" },
        { id: "eu", name: "EU", status: "degraded" },
      ],
      regions: [
        part("US control plane"),
        part("US data plane"),
        part("EU control plane"),
        part("EU data plane", "degraded"),
      ],
    });
    expect(placeStatus(degraded, "US")).toEqual({ status: "operational", parts: [] });
    expect(placeStatus(degraded, "EU")).toEqual({
      status: "degraded",
      parts: [{ name: "Data plane", status: "degraded" }],
    });
    expect(placeStatus(degraded, "AP")).toBeUndefined();
    // Every part in the same state: the place says it all.
    const down = locatedProduct({
      locations: [{ id: "us", name: "US", status: "outage" }],
      regions: [part("US control plane", "outage"), part("US data plane", "outage")],
    });
    expect(placeStatus(down, "US")).toEqual({ status: "outage", parts: [] });
    // A part without data makes the place unknown, and is named.
    const silent = locatedProduct({
      locations: [{ id: "us", name: "US", status: "unknown" }],
      regions: [part("US control plane"), part("US data plane", "unknown")],
    });
    expect(placeStatus(silent, "US")).toEqual({
      status: "unknown",
      parts: [{ name: "Data plane", status: "unknown" }],
    });
    // Every part that is not operational is named, with its own status.
    const mixed = locatedProduct({
      locations: [{ id: "eu", name: "EU", status: "outage" }],
      regions: [part("EU control plane", "maintenance"), part("EU data plane", "outage")],
    });
    expect(placeStatus(mixed, "EU")?.parts).toEqual([
      { name: "Data plane", status: "outage" },
      { name: "Control plane", status: "maintenance" },
    ]);
    // A region that is a place itself.
    expect(placeStatus(product(), "US")).toEqual({ status: "operational", parts: [] });
  });
});

describe("coveredDays", () => {
  const day = (date: string, status: Day["status"]): Day => ({
    date,
    status,
    minutes: {},
    incidentIds: [],
  });
  const strip = [
    day("2026-10-19", "operational"),
    day("2026-10-20", "operational"),
    day("2026-10-21", "outage"),
    day("2026-10-22", "operational"),
  ];

  it("reads a day not fully covered as no data, unless a problem is known", () => {
    expect(coveredDays(strip, new Date("2026-10-20T09:00:00Z")).map((d) => d.status)).toEqual([
      "operational",
      "unknown",
      "outage",
      "unknown",
    ]);
  });

  it("leaves the days as they are while the data is current", () => {
    expect(coveredDays(strip, null)).toBe(strip);
  });
});
