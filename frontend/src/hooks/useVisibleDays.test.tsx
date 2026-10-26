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

import { act, render, renderHook, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import { HistoryStrip } from "../components/HistoryStrip";
import { ThemeRoot } from "../theme/ThemeRoot";
import { formatHistoryDate } from "../lib/time";
import { days } from "../test/factories";
import { setViewportWidth } from "../test/viewport";
import { daysFor, useVisibleDays } from "./useVisibleDays";

afterEach(() => {
  setViewportWidth(1024);
});

describe("daysFor", () => {
  it.each([
    [false, false, 30],
    [true, false, 60],
    [true, true, 90],
    [false, true, 90],
  ])("medium %s, large %s shows %d days", (medium, large, count) => {
    expect(daysFor(medium, large)).toBe(count);
  });
});

describe("useVisibleDays", () => {
  it.each([
    [360, 30],
    [599, 30],
    [600, 60],
    [899, 60],
    [900, 90],
    [1400, 90],
  ])("at %d px shows %d days", (width, count) => {
    setViewportWidth(width);
    const { result } = renderHook(() => useVisibleDays());
    expect(result.current).toBe(count);
  });

  it("follows a resize", () => {
    setViewportWidth(1200);
    const { result } = renderHook(() => useVisibleDays());
    expect(result.current).toBe(90);
    act(() => {
      setViewportWidth(700);
    });
    expect(result.current).toBe(60);
    act(() => {
      setViewportWidth(360);
    });
    expect(result.current).toBe(30);
  });
});

describe("HistoryStrip range", () => {
  const history = days(90, {
    70: { status: "degraded", incidentIds: ["slow"] },
    10: { status: "outage", incidentIds: ["down"] },
  });
  const show = () =>
    render(
      <ThemeRoot>
        <HistoryStrip productName="API Platform" days={history} incidents={new Map()} />
      </ThemeRoot>,
    );

  it("shows 30 days below 600 px, with matching caption, summary and grid name", () => {
    setViewportWidth(360);
    show();
    expect(screen.getAllByRole("gridcell")).toHaveLength(30);
    expect(
      screen.getByRole("grid", { name: "30-day history for API Platform, UTC days" }),
    ).toBeInTheDocument();
    expect(screen.getByText(formatHistoryDate("2026-09-21"))).toBeInTheDocument();
    // Only the degraded day (index 70) is in the last 30; the outage (index 10) is not.
    expect(screen.getByText("30 days: 1 incident, 0 days without data")).toBeInTheDocument();
  });

  it("shows 60 days from 600 to 899 px and 90 from 900 px", () => {
    setViewportWidth(700);
    const { unmount } = show();
    expect(screen.getAllByRole("gridcell")).toHaveLength(60);
    expect(screen.getByText(formatHistoryDate("2026-08-22"))).toBeInTheDocument();
    unmount();
    setViewportWidth(900);
    show();
    expect(screen.getAllByRole("gridcell")).toHaveLength(90);
    expect(screen.getByText(formatHistoryDate("2026-07-23"))).toBeInTheDocument();
  });

  it("keeps roving focus inside the visible range and one tab stop", async () => {
    setViewportWidth(360);
    const user = userEvent.setup();
    show();
    const options = screen.getAllByRole("gridcell");
    expect(options.filter((o) => o.tabIndex === 0)).toHaveLength(1);
    options[29]?.focus();
    await user.keyboard("{Home}");
    expect(options[0]).toHaveFocus();
    await user.keyboard("{ArrowLeft}");
    expect(options[0]).toHaveFocus();
    await user.keyboard("{End}");
    expect(options[29]).toHaveFocus();
  });

  it("keeps the focused day when the range grows", async () => {
    setViewportWidth(360);
    const user = userEvent.setup();
    show();
    const before = screen.getAllByRole("gridcell");
    before[29]?.focus();
    await user.keyboard("{ArrowLeft}");
    expect(before[28]).toHaveFocus();
    act(() => {
      setViewportWidth(1200);
    });
    const after = screen.getAllByRole("gridcell");
    expect(after).toHaveLength(90);
    expect(after[88]?.tabIndex).toBe(0);
  });
});
