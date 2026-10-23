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
import { afterEach, describe, expect, it, vi } from "vitest";
import { PastIncidents } from "../components/PastIncidents";
import { apiTime, days, incident, product } from "../test/factories";
import { ThemeRoot } from "../theme/ThemeRoot";
import { missingIncidents, notCoveredBefore } from "./dataNotes";
import { dayDetail } from "./history";
import { groupByDay } from "./incidents";
import { formatClock, formatUtcClock, localDayKey, utcDayKey } from "./time";

/*
 * Where UTC (the history strip, data times) meets the reader's zone (Past
 * incidents, incident times). These hold in any zone; `npm test` also runs
 * the whole suite in Asia/Colombo and America/Sao_Paulo, where they bite.
 */

const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;

afterEach(() => {
  vi.useRealTimers();
});

describe(`UTC days and local days, in ${zone}`, () => {
  // 23:30 UTC: the next day east of UTC, the same day west of it.
  const late = new Date("2026-10-20T23:30:00Z");

  it("puts an incident on its UTC day in the strip and on its local day in Past incidents", () => {
    const resolved = new Date(late.getTime() + 20 * 60_000);
    const item = incident({ id: "late", startedAt: late, resolvedAt: resolved });
    const strip = days(1, { 0: { date: utcDayKey(late), incidentIds: ["late"] } })[0]!;
    expect(dayDetail(strip, new Map([["late", item]]), resolved).titles).toEqual([
      "Elevated latency",
    ]);
    const groups = groupByDay([item], new Date(resolved.getTime() + 60_000), 3);
    const local = groups.filter((g) => g.incidents.length > 0).map((g) => g.key);
    expect(local).toContain(localDayKey(late));
    // It covers 23:30 to 23:50 UTC: one local day unless that crosses local midnight.
    expect(local).toHaveLength(localDayKey(late) === localDayKey(resolved) ? 1 : 2);
  });

  it("covers a local day only when the feed's last fetch is after its local midnight", () => {
    const stoppedAt = new Date("2026-10-21T02:15:00Z");
    const moesif = product({
      id: "moesif",
      freshness: {
        checkedAt: { components: stoppedAt, incidents: stoppedAt, uptime: stoppedAt },
        stale: { components: false, incidents: true, uptime: false },
      },
    });
    const missing = missingIncidents([moesif], []);
    const [today, yesterday] = groupByDay([], new Date(stoppedAt.getTime() + 60_000), 2);
    expect(today?.key).toBe(localDayKey(stoppedAt));
    expect(notCoveredBefore(missing, today!.end)).toHaveLength(1);
    expect(notCoveredBefore(missing, yesterday!.end)).toHaveLength(0);
  });

  it("speaks only for the other products on the local day a feed stopped", () => {
    // Mid-afternoon UTC: no zone's midnight falls in the few minutes since the stop.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-21T14:17:00Z"));
    const stoppedAt = apiTime(5 * 60_000);
    const moesif = product({
      id: "moesif",
      name: "Moesif",
      freshness: {
        checkedAt: { components: stoppedAt, incidents: stoppedAt, uptime: stoppedAt },
        stale: { components: false, incidents: true, uptime: false },
      },
    });
    render(
      <ThemeRoot>
        <PastIncidents
          state={{ incidents: [], checkedAt: null, lastSuccessAt: new Date(), failed: false }}
          products={[product(), moesif]}
        />
      </ThemeRoot>,
    );
    const [today, yesterday] = screen
      .getAllByRole("region")
      .filter((r) => r.getAttribute("aria-labelledby")?.startsWith("day-"));
    expect(
      within(today!).getByText("No incidents reported for the other product."),
    ).toBeInTheDocument();
    expect(within(yesterday!).getByText("No incidents reported.")).toBeInTheDocument();
  });

  it("names the reader's zone on local times and UTC on data times", () => {
    expect(formatUtcClock(late).endsWith(" UTC")).toBe(true);
    if (new Date(2026, 9, 20).getTimezoneOffset() !== 0) {
      expect(formatClock(late)).not.toBe(formatUtcClock(late));
    }
  });
});
