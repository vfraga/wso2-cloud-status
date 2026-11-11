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

import { screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { formatClock, formatDateClock, formatUtcClock, formatUtcDateTime } from "../lib/time";
import { incident } from "../test/factories";
import { wrap } from "../test/render";
import { ThemeRoot } from "../theme/ThemeRoot";
import { IncidentItem } from "./IncidentMeta";

describe("IncidentItem", () => {
  const now = new Date("2026-10-20T10:00:00Z");

  it("shows an ongoing incident with state and duration, UTC in the title", () => {
    wrap(
      <ul>
        <IncidentItem
          incident={incident({
            resolvedAt: null,
            state: "investigating",
            startedAt: new Date("2026-10-20T08:00:00Z"),
          })}
          productName="API Platform"
          now={now}
          withDate
          titleAs="h3"
        />
      </ul>,
    );
    expect(screen.getByRole("heading", { level: 3, name: "Elevated latency" })).toBeInTheDocument();
    expect(screen.getByText("Investigating")).toBeInTheDocument();
    expect(screen.getByText(/Ongoing for 2h/)).toBeInTheDocument();
    expect(document.querySelector("time")).toHaveAttribute(
      "title",
      formatUtcDateTime(new Date("2026-10-20T08:00:00Z")),
    );
  });

  it("stops the duration of an ongoing incident at the last known time when its feed stopped", () => {
    const lastKnown = new Date("2026-10-20T09:30:00Z");
    wrap(
      <ul>
        <IncidentItem
          incident={incident({
            resolvedAt: null,
            state: "investigating",
            startedAt: new Date("2026-10-20T08:00:00Z"),
          })}
          productName="API Platform"
          now={new Date("2026-10-20T16:00:00Z")}
          lastKnownAt={lastKnown}
        />
      </ul>,
    );
    expect(
      screen.getByText(
        `Ongoing for at least 1h 30m. Last known as of ${formatUtcClock(lastKnown)}.`,
        { exact: false },
      ),
    ).toBeInTheDocument();
    expect(screen.queryByText(/Ongoing for 8h/)).toBeNull();
  });

  it("shows start, end and duration of a resolved incident, with the end date when it crosses local midnight", () => {
    // Local times: the reader's midnight, whatever the zone.
    const started = new Date(2026, 9, 19, 23, 0);
    const ended = new Date(2026, 9, 20, 1, 0);
    const { rerender } = wrap(
      <ul>
        <IncidentItem
          incident={incident({ startedAt: started, resolvedAt: ended })}
          productName="API Platform"
          now={now}
        />
      </ul>,
    );
    expect(screen.getByText(/Lasted 2h/)).toBeInTheDocument();
    const times = document.querySelectorAll("time");
    expect(times).toHaveLength(2);
    expect(times[0]?.textContent).toBe(formatClock(started));
    expect(times[1]?.textContent).toBe(formatDateClock(ended));
    // The same day: the end has no date.
    const later = new Date(2026, 9, 19, 23, 30);
    rerender(
      <ThemeRoot>
        <ul>
          <IncidentItem
            incident={incident({ startedAt: started, resolvedAt: later })}
            productName="API Platform"
            now={now}
          />
        </ul>
      </ThemeRoot>,
    );
    expect(document.querySelectorAll("time")[1]?.textContent).toBe(formatClock(later));
  });

  it("labels an impact the API does not know as Unknown impact, not as missing data", () => {
    wrap(
      <ul>
        <IncidentItem
          incident={incident({ impact: "unknown" })}
          productName="API Platform"
          now={now}
        />
      </ul>,
    );
    expect(screen.getByText("Unknown impact")).toBeInTheDocument();
    expect(screen.queryByText("Status unavailable")).not.toBeInTheDocument();
  });
});
