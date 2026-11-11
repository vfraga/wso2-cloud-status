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

import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Status } from "../api/types";
import { PageNowProvider } from "../hooks/useNow";
import { formatHistoryDate } from "../lib/time";
import { days, incident } from "../test/factories";
import { wrap } from "../test/render";
import { ThemeRoot } from "../theme/ThemeRoot";
import { dayFill } from "./dayFill";
import { HistoryStrip } from "./HistoryStrip";

afterEach(() => {
  vi.useRealTimers();
});

describe("HistoryStrip", () => {
  const d = days(90, {
    88: { status: "degraded", minutes: { degraded: 95 }, incidentIds: ["inc-1"] },
    3: { status: "unknown" },
  });

  it("draws a day the data covers only in part as no data, never quiet", () => {
    wrap(
      <HistoryStrip
        productName="API Platform"
        days={d}
        incidents={new Map([["inc-1", incident()]])}
        completeUntil={new Date("2026-10-20T09:00:00Z")}
      />,
    );
    const options = screen.getAllByRole("gridcell");
    expect(options[89]).toHaveAccessibleName(
      /\(UTC\): No data\. Incident information complete only until /,
    );
    expect(options[88]).toHaveAccessibleName(/\(UTC\): Degraded performance\./);
  });

  it("is one tab stop with a hidden text summary", async () => {
    const user = userEvent.setup();
    wrap(
      <>
        <button type="button">before</button>
        <HistoryStrip
          productName="API Platform"
          days={d}
          incidents={new Map([["inc-1", incident()]])}
        />
        <button type="button">after</button>
      </>,
    );
    expect(screen.getByText("90 days: 1 incident, 1 day without data")).toBeInTheDocument();
    const options = screen.getAllByRole("gridcell");
    expect(options).toHaveLength(90);
    expect(options.filter((o) => o.tabIndex === 0)).toHaveLength(1);

    await user.tab();
    await user.tab();
    expect(options[89]).toHaveFocus();
    await user.tab();
    expect(screen.getByRole("button", { name: "1 incident for API Platform" })).toHaveFocus();
    await user.tab();
    expect(screen.getByRole("button", { name: "after" })).toHaveFocus();
  });

  it("moves with arrow keys and shows the tooltip for the focused day", async () => {
    const user = userEvent.setup();
    wrap(
      <HistoryStrip
        productName="API Platform"
        days={d}
        incidents={new Map([["inc-1", incident()]])}
      />,
    );
    const options = screen.getAllByRole("gridcell");
    options[89]?.focus();
    await user.keyboard("{ArrowLeft}");
    expect(options[88]).toHaveFocus();
    expect(options[88]).toHaveAccessibleName(
      /Degraded performance\. Degraded performance 1h 35m\. Incidents: Elevated latency/,
    );
    expect(screen.getByText("Degraded performance: 1h 35m")).toBeInTheDocument();
    expect(screen.getByText("Elevated latency", { selector: "li" })).toBeInTheDocument();

    await user.keyboard("{Home}");
    expect(options[0]).toHaveFocus();
    await user.keyboard("{ArrowLeft}");
    expect(options[0]).toHaveFocus();
    await user.keyboard("{End}");
    expect(options[89]).toHaveFocus();
    await user.keyboard("{ArrowRight}");
    expect(options[89]).toHaveFocus();
    await user.keyboard("x");
    expect(options[89]).toHaveFocus();
    await user.keyboard("{Escape}");
    expect(screen.queryByText("No incidents")).not.toBeInTheDocument();
  });

  it("shows the tooltip on hover and hides it shortly after the pointer leaves", async () => {
    const user = userEvent.setup();
    wrap(<HistoryStrip productName="X" days={d} incidents={new Map()} />);
    const options = screen.getAllByRole("gridcell");
    await user.hover(options[3]!);
    expect(screen.getByText("No data")).toBeInTheDocument();
    await user.unhover(options[3]!);
    await waitFor(() => {
      expect(screen.queryByText("No data")).not.toBeInTheDocument();
    });
  });

  it("closes a hover-opened tooltip on Escape, with focus elsewhere (WCAG 1.4.13)", async () => {
    const user = userEvent.setup();
    wrap(<HistoryStrip productName="X" days={d} incidents={new Map()} />);
    await user.hover(screen.getAllByRole("gridcell")[3]!);
    expect(screen.getByText("No data")).toBeInTheDocument();
    expect(document.activeElement).toBe(document.body);
    await user.keyboard("{Escape}");
    expect(screen.queryByText("No data")).not.toBeInTheDocument();
  });

  it("opens the tooltip below the strip, clear of the row's name and status", async () => {
    const user = userEvent.setup();
    wrap(<HistoryStrip productName="X" days={d} incidents={new Map()} />);
    await user.hover(screen.getAllByRole("gridcell")[3]!);
    const popper = document.querySelector(".MuiPopper-root");
    await waitFor(() => {
      expect(popper).toHaveAttribute("data-popper-placement", "bottom");
    });
  });

  it("flips above only at the end of the document, and scrolls a tapped tooltip into view", async () => {
    const user = userEvent.setup();
    const scroll = vi.spyOn(Element.prototype, "scrollIntoView");
    wrap(<HistoryStrip productName="X" days={d} incidents={new Map()} />);
    // Hovering does not move the page.
    await user.hover(screen.getAllByRole("gridcell")[3]!);
    const popper = document.querySelector(".MuiPopper-root");
    await waitFor(() => {
      expect(popper).toHaveAttribute("data-popper-placement", "bottom");
    });
    expect(scroll).not.toHaveBeenCalled();
    await user.unhover(screen.getAllByRole("gridcell")[3]!);
    // A tap or the keyboard focuses the cell: the tooltip is brought into view.
    act(() => {
      screen.getAllByRole("gridcell")[89]!.focus();
    });
    await waitFor(() => {
      expect(scroll).toHaveBeenCalledWith({ block: "nearest" });
    });
    scroll.mockRestore();
  });

  it("draws a problem day full height and a quiet or no-data day at 60%, as a rounded bar", () => {
    const statuses: Status[] = ["outage", "degraded", "maintenance", "operational", "unknown"];
    expect(statuses.map((s) => dayFill(s)["&::before"].height)).toEqual([
      "100%",
      "100%",
      "100%",
      "60%",
      "60%",
    ]);
    // The bar is its own box, rounded like its cell at both ends.
    expect(dayFill("degraded")["&::before"].borderRadius).toBe("inherit");
    // A legend's marks are one size.
    expect(statuses.map((s) => dayFill(s, { full: true })["&::before"].height)).toEqual(
      statuses.map(() => "100%"),
    );
  });

  it("draws the days in system colours under forced colors", () => {
    wrap(<HistoryStrip productName="X" days={d} incidents={new Map()} />);
    const css = Array.from(document.querySelectorAll("style"))
      .map((el) => el.textContent)
      .join("\n");
    expect(css).toMatch(
      /@media \(forced-colors: active\)\{[^}]*forced-color-adjust:none;background-image:linear-gradient\(CanvasText, CanvasText\)/,
    );
    expect(css).toMatch(
      /forced-color-adjust:none;background-image:linear-gradient\(GrayText, GrayText\)/,
    );
    expect(css).toMatch(/background-image:repeating-linear-gradient\(45deg, GrayText/);
  });

  it("keeps the tooltip open while the pointer is on it (WCAG 1.4.13)", async () => {
    const user = userEvent.setup();
    wrap(<HistoryStrip productName="X" days={d} incidents={new Map()} />);
    await user.hover(screen.getAllByRole("gridcell")[3]!);
    const tooltip = screen.getByText("No data").closest("[aria-hidden='true']");
    expect(tooltip).not.toBeNull();
    await user.hover(tooltip as HTMLElement);
    await new Promise((done) => setTimeout(done, 250));
    expect(screen.getByText("No data")).toBeInTheDocument();
    await user.unhover(tooltip as HTMLElement);
    await waitFor(() => {
      expect(screen.queryByText("No data")).not.toBeInTheDocument();
    });
  });

  it("draws healthy and no-data days lower than problem days", () => {
    wrap(<HistoryStrip productName="X" days={d} incidents={new Map()} />);
    const css = Array.from(document.querySelectorAll("style"))
      .map((el) => el.textContent)
      .join("\n");
    // The bars are drawn by ::before at the two heights; the real heights are measured end to end.
    expect(css).toMatch(/::before\{[^}]*height:60%/);
    expect(css).toMatch(/::before\{[^}]*height:100%/);
  });

  it("captions the number of incidents and lists their days on request", async () => {
    const user = userEvent.setup();
    wrap(
      <HistoryStrip
        productName="API Platform"
        days={days(90, {
          10: { status: "outage", minutes: { outage: 62 }, incidentIds: ["inc-0"] },
          88: { status: "degraded", minutes: { degraded: 95 }, incidentIds: ["inc-1"] },
        })}
        incidents={
          new Map([
            ["inc-0", incident({ id: "inc-0", impact: "outage", title: "API down" })],
            ["inc-1", incident()],
          ])
        }
      />,
    );
    const toggle = screen.getByRole("button", { name: "2 incidents for API Platform" });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(toggle).not.toHaveAttribute("aria-controls");
    await user.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    const list = document.getElementById(toggle.getAttribute("aria-controls") ?? "");
    const items = Array.from(list?.querySelector("ul")?.children ?? []);
    expect(items).toHaveLength(2);
    // Newest first.
    expect(items[0]).toHaveTextContent(`${formatHistoryDate("2026-10-19")} (UTC)`);
    expect(items[0]).toHaveTextContent("Elevated latency");
    expect(items[1]).toHaveTextContent("Service outage: 1h 2m");
    // The day's status shares the line of its date.
    const date = within(items[0] as HTMLElement).getByText(
      `${formatHistoryDate("2026-10-19")} (UTC)`,
    );
    expect(date.parentElement).toContainElement(
      within(items[0] as HTMLElement).getByText("Degraded performance"),
    );
    expect(getComputedStyle(date.parentElement!).flexDirection).toBe("row");
    await user.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "false");
  });

  it("captions a quiet strip without a control", () => {
    const { rerender } = wrap(
      <HistoryStrip productName="X" days={days(30)} incidents={new Map()} />,
    );
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
    expect(screen.getByText("No incidents")).toBeInTheDocument();
    rerender(
      <ThemeRoot>
        <HistoryStrip
          productName="X"
          days={days(30).map((day) => ({ ...day, status: "unknown" as const }))}
          incidents={new Map()}
        />
      </ThemeRoot>,
    );
    expect(screen.getByText("No data", { selector: "span" })).toBeInTheDocument();
  });

  it("names UTC days, captions the first date and shows Today only for today's UTC date", () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
    vi.setSystemTime(new Date("2026-10-20T23:59:30Z"));
    wrap(<HistoryStrip productName="API Platform" days={d} incidents={new Map()} />);
    expect(
      screen.getByRole("grid", { name: "90-day history for API Platform, UTC days" }),
    ).toBeInTheDocument();
    expect(screen.getAllByRole("gridcell")[89]).toHaveAccessibleName(
      `${formatHistoryDate("2026-10-20")} (UTC): No incidents`,
    );
    expect(screen.getByText(formatHistoryDate("2026-07-23"))).toBeInTheDocument();
    expect(screen.getByText("Today")).toBeInTheDocument();
    // The UTC day turns while the page is open; the last cell is now yesterday.
    act(() => {
      vi.advanceTimersByTime(60_000);
    });
    expect(screen.queryByText("Today")).not.toBeInTheDocument();
    expect(screen.getByText(formatHistoryDate("2026-10-20"))).toBeInTheDocument();
  });

  it("names Today on the page's server-corrected clock, not this browser's", () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
    // This browser's clock reads two days ahead of the server's.
    vi.setSystemTime(new Date("2026-10-22T12:00:00Z"));
    wrap(
      <PageNowProvider skewMs={2 * 86_400_000}>
        <HistoryStrip productName="X" days={d} incidents={new Map()} />
      </PageNowProvider>,
    );
    expect(screen.getByText("Today")).toBeInTheDocument();
  });

  it("renders nothing without history", () => {
    wrap(<HistoryStrip productName="X" days={[]} incidents={new Map()} />);
    expect(screen.queryByRole("grid")).not.toBeInTheDocument();
  });
});
