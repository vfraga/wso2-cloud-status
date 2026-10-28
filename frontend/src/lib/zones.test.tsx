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

import { afterEach, describe, expect, it, vi } from "vitest";
import { days, incident } from "../test/factories";
import { dayDetail } from "./history";
import { formatClock, formatDuration, formatUtcClock, utcDayKey } from "./time";

/*
 * Where UTC (the history strip, data times) meets the reader's zone (incident
 * times). These hold in any zone; `npm test` also runs the whole suite in
 * Asia/Colombo and America/Sao_Paulo, where they bite.
 */

const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;

afterEach(() => {
  vi.useRealTimers();
});

describe(`UTC days and local times, in ${zone}`, () => {
  // 23:30 UTC: the next day east of UTC, the same day west of it.
  const late = new Date("2026-10-20T23:30:00Z");

  it("counts an incident's minutes on its UTC day in the strip", () => {
    const resolved = new Date(late.getTime() + 20 * 60_000);
    const item = incident({ id: "late", startedAt: late, resolvedAt: resolved });
    // The API's figure differs, so only a day cut at UTC midnight gives 20 minutes;
    // a day cut at local midnight east of UTC holds none of the incident.
    const strip = days(1, {
      0: { date: utcDayKey(late), incidentIds: ["late"], minutes: { degraded: 5 } },
    })[0]!;
    const detail = dayDetail(strip, new Map([["late", item]]), resolved);
    expect(detail.titles).toEqual(["Elevated latency"]);
    expect(detail.minutes.map((m) => m.text)).toEqual([formatDuration(20 * 60_000)]);
  });

  it("names the reader's zone on local times and UTC on data times", () => {
    expect(formatUtcClock(late).endsWith(" UTC")).toBe(true);
    if (new Date(2026, 9, 20).getTimezoneOffset() !== 0) {
      expect(formatClock(late)).not.toBe(formatUtcClock(late));
    }
  });
});
