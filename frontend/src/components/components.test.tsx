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

import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Status } from "../api/types";
import type { Headline } from "../lib/headline";
import { BANNER_LABEL } from "../lib/status";
import {
  formatClock,
  formatDateClock,
  formatHistoryDate,
  formatUtcClock,
  formatUtcDateTime,
} from "../lib/time";
import { days, incident, locatedProduct, part, product } from "../test/factories";
import { dayFill } from "./dayFill";
import { HistoryLegend } from "./HistoryLegend";
import { Banner } from "./Banner";
import { HistoryStrip } from "./HistoryStrip";
import { IncidentItem } from "./IncidentMeta";
import { LocationPanel, RegionDetailPanel } from "./RegionDetailPanel";
import { ThemeRoot } from "../theme/ThemeRoot";
import { ProductUptime, UptimeFigures, formatPercent, uptimeWindows, windowName } from "./Uptime";
import { ErrorBoundary } from "./ErrorBoundary";
import { ProductListSkeleton } from "./Skeletons";
import { StatusLabel } from "./StatusIcon";
import { ActiveIncidents } from "./ActiveIncidents";
import { StatusTable, StatusTableSkeleton } from "./StatusTable";
import { PageNowProvider } from "../hooks/useNow";

const wrap = (ui: React.ReactElement) => render(<ThemeRoot>{ui}</ThemeRoot>);

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

describe("LocationPanel", () => {
  it("heads a place h3 and its parts h4, by their short names, with groups one level below", () => {
    const region = (name: string) => ({
      ...part(name, "degraded"),
      groups: [
        {
          name: "Runtime",
          status: "degraded" as const,
          components: [{ name: "Gateway", status: "degraded" as const, uptime: [] }],
        },
      ],
    });
    wrap(
      <ul>
        <LocationPanel
          location={{ id: "eu", name: "EU", status: "degraded" }}
          regions={[region("EU control plane"), region("EU data plane")]}
        />
      </ul>,
    );
    expect(screen.getByRole("heading", { level: 3, name: "EU" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 4, name: "Control plane" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 4, name: "Data plane" })).toBeInTheDocument();
    expect(screen.getAllByRole("heading", { level: 5, name: "Runtime" })).toHaveLength(2);
  });
});

describe("HistoryLegend", () => {
  it("names every colour and describes it on focus, hover and tap, closing on Escape", async () => {
    const user = userEvent.setup();
    wrap(<HistoryLegend />);
    const entries = [
      "Service outage",
      "Degraded performance",
      "Maintenance",
      "No incidents",
      "No data: information for this day is unavailable",
    ].map((name) => screen.getByRole("button", { name }));
    await user.tab();
    expect(entries[0]).toHaveFocus();
    expect(await screen.findByRole("tooltip")).toHaveTextContent(
      "An incident that day was a service outage.",
    );
    expect(entries[0]).toHaveAccessibleDescription("An incident that day was a service outage.");
    await user.keyboard("{Escape}");
    await waitFor(() => {
      expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
    });
    // A button: Enter opens the description again.
    await user.keyboard("{Enter}");
    expect(await screen.findByRole("tooltip")).toHaveTextContent(
      "An incident that day was a service outage.",
    );
    await user.keyboard("{Escape}");
    await user.hover(entries[2]!);
    expect(await screen.findByRole("tooltip")).toHaveTextContent(
      "Planned maintenance that day, and no outage or degraded performance.",
    );
  });
});

describe("RegionDetailPanel", () => {
  const region = {
    id: "eu",
    name: "EU",
    status: "operational" as const,
    uptime: [],
    groups: [
      {
        name: "Runtime",
        status: "operational" as const,
        components: [{ name: "Gateway", status: "operational" as const, uptime: [] }],
      },
    ],
  };

  it("points at its panel only while it is open", async () => {
    const user = userEvent.setup();
    wrap(
      <ul>
        <RegionDetailPanel region={region} />
      </ul>,
    );
    const toggle = screen.getByRole("button", { name: "EU" });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(toggle).not.toHaveAttribute("aria-controls");
    await user.click(toggle);
    const panel = document.getElementById(toggle.getAttribute("aria-controls") ?? "");
    expect(panel).toContainElement(screen.getByText("Gateway"));
    // An operational component shows the check alone; a screen reader still hears the word.
    const row = screen.getByText("Gateway").closest("li")!;
    expect(within(row).getByText("Operational")).toHaveClass("cs-visually-hidden");
    await user.click(toggle);
    expect(toggle).not.toHaveAttribute("aria-controls");
  });

  it("opens when its status turns to a problem and closes when it recovers, unless the reader toggled it", async () => {
    const user = userEvent.setup();
    const panel = (status: "operational" | "degraded") => (
      <ThemeRoot>
        <ul>
          <RegionDetailPanel region={{ ...region, status }} />
        </ul>
      </ThemeRoot>
    );
    const { rerender } = render(panel("operational"));
    const toggle = () => screen.getByRole("button", { name: "EU" });
    rerender(panel("degraded"));
    expect(toggle()).toHaveAttribute("aria-expanded", "true");
    rerender(panel("operational"));
    expect(toggle()).toHaveAttribute("aria-expanded", "false");
    // Opened by the reader: it stays open through a change of status.
    await user.click(toggle());
    rerender(panel("degraded"));
    rerender(panel("operational"));
    expect(toggle()).toHaveAttribute("aria-expanded", "true");
  });
});

describe("RegionDetailPanel without components", () => {
  it("shows the name as plain text, never an empty panel, and says why when nothing is known", () => {
    const { rerender } = wrap(
      <ul>
        <RegionDetailPanel
          region={{ id: "us", name: "US", status: "unknown", uptime: [], groups: [] }}
        />
      </ul>,
    );
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 3, name: "US" })).toBeInTheDocument();
    expect(screen.getByText("No component data is available right now.")).toBeInTheDocument();
    const us = {
      id: "us",
      name: "US",
      status: "operational" as const,
      uptime: [{ window: "7d", percent: 100 }],
      groups: [],
    };
    rerender(
      <ThemeRoot>
        <ProductUptime.Provider value={uptimeWindows([us])}>
          <ul>
            <RegionDetailPanel region={us} />
          </ul>
        </ProductUptime.Provider>
      </ThemeRoot>,
    );
    expect(screen.queryByText("No component data is available right now.")).not.toBeInTheDocument();
    expect(screen.getByRole("group", { name: "Uptime for US" })).toBeInTheDocument();
  });
});

describe("Banner", () => {
  const base = { loading: false, checkedAt: null, lastSuccessAt: new Date(), failed: false };
  const headline = (status: Status, detail?: string): Headline => ({
    status,
    label: BANNER_LABEL[status],
    ...(detail === undefined ? {} : { detail }),
  });

  it("shows icon-backed text for each status, with the line under it", () => {
    const { rerender } = wrap(
      <Banner {...base} headline={headline("outage", "Affected: API Platform (EU).")} />,
    );
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Service outage");
    expect(screen.getByText("Affected: API Platform (EU).")).toBeInTheDocument();
    rerender(
      <ThemeRoot>
        <Banner {...base} headline={headline("unknown")} loading />
      </ThemeRoot>,
    );
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Checking status");
  });

  it("lists the statuses under the headline when it names more than one", () => {
    const lines = [
      { status: "outage" as const, text: "Service outage: Integration Platform (EU)." },
      { status: "maintenance" as const, text: "Under maintenance: API Platform (EU)." },
      { status: null, text: "The other 4 products are operational." },
    ];
    wrap(
      <Banner
        {...base}
        headline={{
          ...headline("outage"),
          detail: lines.map((l) => l.text).join(" "),
          lines,
        }}
      />,
    );
    const banner = screen.getByRole("region", { name: "Overall status" });
    const items = within(banner).getAllByRole("listitem");
    expect(items.map((i) => i.textContent)).toEqual([lines[0]!.text, lines[1]!.text]);
    expect(items[0]!.querySelector("svg[aria-hidden='true']")).not.toBeNull();
    expect(within(banner).getByText("The other 4 products are operational.")).toBeInTheDocument();
  });

  it("names the subject for screen readers and can take focus", () => {
    wrap(<Banner {...base} headline={headline("degraded")} subject="API Platform" />);
    const heading = screen.getByRole("heading", { level: 1 });
    expect(heading).toHaveAccessibleName("API Platform: Degraded performance");
    expect(heading).toHaveAttribute("tabindex", "-1");
  });

  it("shows a calm notice when the API is unreachable", () => {
    wrap(<Banner {...base} headline={headline("operational")} failed />);
    expect(screen.getByRole("status")).toHaveTextContent("Status data may be out of date");
  });

  it("says it cannot reach the service when nothing has loaded yet", () => {
    wrap(<Banner {...base} lastSuccessAt={null} headline={headline("unknown")} failed />);
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Status unavailable");
    expect(screen.getByRole("status")).toHaveTextContent(
      "We cannot reach the status service right now. This page will keep trying.",
    );
    expect(screen.getByRole("status")).not.toHaveTextContent("out of date");
  });

  it("shows the notice when the data is more than five minutes old", () => {
    wrap(
      <Banner
        {...base}
        headline={headline("operational")}
        checkedAt={new Date(Date.now() - 6 * 60_000)}
      />,
    );
    expect(screen.getByRole("status")).toHaveTextContent("more than 5 minutes ago");
    expect(screen.getByText("Status checked 6 min ago")).toBeInTheDocument();
  });

  it("keeps an empty live region mounted for fresh data", () => {
    wrap(
      <Banner
        {...base}
        headline={headline("operational")}
        checkedAt={new Date(Date.now() - 20_000)}
      />,
    );
    expect(screen.getByRole("status")).toBeEmptyDOMElement();
    expect(screen.getByText("Status checked just now")).toBeInTheDocument();
  });

  it.each([
    // checked_at is floored and can trail the latest check by a minute.
    [100_000, "Status checked just now"],
    [170_000, "Status checked 1 min ago"],
    [4 * 60_000 + 50_000, "Status checked 3 min ago"],
  ])("counts current data's age from the end of its minute (%d ms)", (ms, text) => {
    wrap(
      <Banner {...base} headline={headline("operational")} checkedAt={new Date(Date.now() - ms)} />,
    );
    expect(screen.getByText(text)).toBeInTheDocument();
    expect(screen.getByRole("status")).toBeEmptyDOMElement();
  });

  it("reads Status unavailable once the page has not refreshed for longer than the limit", () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
    vi.setSystemTime(new Date("2026-10-20T12:00:00Z"));
    wrap(
      <Banner
        {...base}
        lastSuccessAt={new Date()}
        headline={headline("degraded", "Affected: API Platform.")}
        secondary="Incident information for Moesif has not been updated since 11:50 UTC."
        failed
      />,
    );
    const heading = screen.getByRole("heading", { level: 1 });
    const live = screen.getByRole("status");
    expect(heading).toHaveTextContent("Degraded performance");
    expect(live).toHaveTextContent("We could not refresh it just now");
    act(() => {
      vi.advanceTimersByTime(5 * 60_000);
    });
    expect(heading).toHaveTextContent("Degraded performance");
    act(() => {
      vi.advanceTimersByTime(5_000);
    });
    expect(heading).toHaveTextContent("Status unavailable");
    // The lines under the headline described the data the banner no longer vouches for.
    expect(screen.queryByText("Affected: API Platform.")).not.toBeInTheDocument();
    expect(screen.queryByText(/^Incident information for Moesif/)).not.toBeInTheDocument();
    // The same live region, so the change is announced.
    expect(screen.getByRole("status")).toBe(live);
    expect(live).toHaveTextContent(
      "Status data may be out of date. We have not been able to refresh it for more than 5 minutes, so this page shows the last known state. We will keep trying.",
    );
  });

  it("reads Status unavailable for a response that was already too old on arrival", () => {
    wrap(
      <Banner
        {...base}
        headline={headline("operational")}
        checkedAt={new Date(Date.now() - 3 * 3_600_000)}
        servedStale
      />,
    );
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Status unavailable");
    expect(screen.getByText("Status checked 3 hours ago")).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent(
      "Status data may be out of date. The data we received was last checked more than 5 minutes ago, so this page cannot confirm the current status.",
    );
  });

  it("keeps the status while the latest attempt has not failed, however old the data", () => {
    wrap(
      <Banner
        {...base}
        headline={headline("operational")}
        checkedAt={new Date(Date.now() - 20 * 60_000)}
        lastSuccessAt={new Date(Date.now() - 20 * 60_000)}
        failed={false}
      />,
    );
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("All systems operational");
    expect(screen.getByRole("status")).toHaveTextContent(
      "The last check was more than 5 minutes ago.",
    );
  });

  it("announces the notice in the same live region when data turns stale", () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
    vi.setSystemTime(new Date("2026-10-20T12:00:00Z"));
    wrap(
      <Banner
        {...base}
        headline={headline("operational")}
        checkedAt={new Date("2026-10-20T11:56:00Z")}
        lastSuccessAt={new Date()}
      />,
    );
    const live = screen.getByRole("status");
    expect(live).toBeEmptyDOMElement();
    act(() => {
      vi.advanceTimersByTime(65_000);
    });
    expect(screen.getByRole("status")).toBe(live);
    expect(live).toHaveTextContent("The last check was more than 5 minutes ago.");
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("All systems operational");
  });

  it("announces a change of the headline on an open page, not the first status", () => {
    const { container, rerender } = wrap(
      <Banner {...base} loading headline={headline("unknown")} />,
    );
    const announcer = container.querySelector('[aria-live="polite"]')!;
    rerender(
      <ThemeRoot>
        <Banner {...base} headline={headline("operational")} />
      </ThemeRoot>,
    );
    expect(announcer).toBeEmptyDOMElement();
    rerender(
      <ThemeRoot>
        <Banner {...base} headline={headline("outage")} />
      </ThemeRoot>,
    );
    expect(announcer).toHaveTextContent("Status changed: Service outage.");
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Service outage");
    // A later notice is its own region: it does not repeat the change.
    rerender(
      <ThemeRoot>
        <Banner {...base} headline={headline("outage")} failed />
      </ThemeRoot>,
    );
    expect(screen.getByRole("status")).toHaveTextContent("We could not refresh it just now");
    expect(screen.getByRole("status")).not.toHaveTextContent("Status changed");
  });

  it("says the age line covers the other products when some are late", () => {
    wrap(<Banner {...base} headline={headline("unknown")} checkedAt={new Date()} someLate />);
    expect(screen.getByText(/^Other products checked /)).toBeInTheDocument();
  });
});

describe("incidents", () => {
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

  it("lists active incidents or nothing", () => {
    const products = new Map([["api-platform", product()]]);
    const { container, rerender } = wrap(<ActiveIncidents incidents={[]} products={products} />);
    expect(container).toBeEmptyDOMElement();
    rerender(
      <ThemeRoot>
        <ActiveIncidents
          incidents={[incident({ resolvedAt: null, productId: "unknown-product" })]}
          products={products}
        />
      </ThemeRoot>,
    );
    expect(screen.getByRole("heading", { name: "Active incidents" })).toBeInTheDocument();
    expect(screen.getByText("unknown-product")).toBeInTheDocument();
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
  });

  it("links an active incident to its product here, and nowhere else", () => {
    wrap(
      <ActiveIncidents
        incidents={[incident({ resolvedAt: null, state: "investigating" })]}
        products={new Map([["api-platform", product()]])}
      />,
    );
    expect(screen.getByRole("link", { name: "API Platform" })).toHaveAttribute(
      "href",
      "/products/api-platform",
    );
    expect(screen.getAllByRole("link")).toHaveLength(1);
    expect(screen.getByText("Degraded performance")).toBeInTheDocument();
  });
});

describe("StatusTable", () => {
  const eu = { id: "eu", name: "EU", status: "operational" as const };
  const us = { id: "us", name: "US", status: "operational" as const };
  const usOnly = product({
    id: "moesif",
    name: "Moesif",
    description: "Moesif analytics",
    regions: product().regions.slice(0, 1),
  });

  afterEach(() => {
    window.history.pushState(null, "", "/");
  });

  it("has a row per product and a column per place, each cell a status in words", () => {
    wrap(<StatusTable products={[locatedProduct({ description: "Bijira" }), usOnly]} />);
    const table = screen.getByRole("table", { name: "Current status of each product by region" });
    expect(
      within(table)
        .getAllByRole("columnheader")
        .map((h) => h.textContent),
    ).toEqual(["Product", "US", "EU"]);
    const rows = within(table).getAllByRole("row").slice(1);
    expect(rows.map((r) => within(r).getByRole("rowheader").textContent)).toEqual([
      "API PlatformBijira",
      "MoesifMoesif analytics",
    ]);
    expect(within(rows[0]!).getAllByText("Operational")).toHaveLength(2);
    // A place the product does not run in shows "-", and says so to a screen reader.
    expect(within(rows[1]!).getByText("No EU region")).toBeInTheDocument();
    expect(within(rows[1]!).getByRole("link", { name: "Moesif" })).toHaveAttribute(
      "href",
      "/products/moesif",
    );
  });

  it("says how much of a place is out, then names each part that is not operational", () => {
    const degraded = locatedProduct({
      locations: [us, { ...eu, status: "outage" }],
      regions: [
        part("US control plane"),
        part("US data plane"),
        part("EU control plane", "maintenance"),
        part("EU data plane", "outage"),
      ],
    });
    wrap(<StatusTable products={[degraded]} />);
    const cells = screen.getAllByRole("cell");
    expect(within(cells[1]!).getByText("Partial outage")).toBeInTheDocument();
    expect(within(cells[1]!).queryByText("Service outage")).toBeNull();
    // Each part shows its icon and name; a screen reader hears its status.
    for (const [name, spoken] of [
      ["Data plane", "Data plane: service outage"],
      ["Control plane", "Control plane: under maintenance"],
    ] as const) {
      expect(within(cells[1]!).getByText(name)).toHaveAttribute("aria-hidden", "true");
      expect(within(cells[1]!).getByText(spoken)).toHaveClass("cs-visually-hidden");
    }
    expect(within(cells[0]!).queryByText(/plane/)).not.toBeInTheDocument();
  });

  it("says major outage where every part of a place is out, and keeps a lone region's words", () => {
    const down = locatedProduct({
      locations: [us, { ...eu, status: "outage" }],
      regions: [
        part("US control plane"),
        part("US data plane"),
        part("EU control plane", "outage"),
        part("EU data plane", "outage"),
      ],
    });
    // A region that is a place itself is one part, not a roll-up.
    const lone = product({ regions: [{ ...product().regions[0]!, status: "outage" }] });
    wrap(<StatusTable products={[down, lone]} />);
    const rows = screen.getAllByRole("row").slice(1);
    const euCell = within(rows[0]!).getAllByRole("cell")[1]!;
    expect(within(euCell).getByText("Major outage")).toBeInTheDocument();
    expect(within(euCell).queryByText(/plane/)).toBeNull();
    expect(within(rows[1]!).getByText("Service outage")).toBeInTheDocument();
  });

  it("shows the status of a product without regions across the columns, never 'no region'", () => {
    const silent = product({ id: "agent", name: "Agent", status: "unknown", regions: [] });
    wrap(<StatusTable products={[locatedProduct(), silent]} />);
    const row = screen.getAllByRole("row").at(-1)!;
    expect(within(row).getByText("Status unavailable")).toBeInTheDocument();
    expect(within(row).queryByText(/region$/)).not.toBeInTheDocument();
    expect(within(row).getByRole("cell")).toHaveAttribute("colspan", "2");
  });

  it("says under the name when an incident that names no region puts the product above every place", () => {
    // statusd: product status outage from an active incident, every location operational.
    wrap(<StatusTable products={[locatedProduct({ status: "outage" }), usOnly]} />);
    const [first, second] = screen.getAllByRole("rowheader");
    expect(within(first!).getByText("Service outage, region not stated")).toBeInTheDocument();
    expect(within(second!).queryByText(/region not stated/)).toBeNull();
  });

  it("adds no line when a place already carries the product's status", () => {
    const placed = locatedProduct({
      status: "outage",
      locations: [us, { ...eu, status: "outage" }],
      regions: [
        part("US control plane"),
        part("US data plane"),
        part("EU control plane"),
        part("EU data plane", "outage"),
      ],
    });
    wrap(<StatusTable products={[placed]} />);
    expect(screen.queryByText(/region not stated/)).toBeNull();
  });

  it("opens the product from anywhere on its row", async () => {
    wrap(<StatusTable products={[locatedProduct()]} />);
    await userEvent.click(screen.getAllByText("Operational")[0]!);
    expect(window.location.pathname).toBe("/products/api-platform");
  });

  it("leaves this tab where it is when the name is opened in another", async () => {
    window.history.replaceState(null, "", "/");
    wrap(<StatusTable products={[locatedProduct()]} />);
    const user = userEvent.setup();
    for (const key of ["Meta", "Control", "Shift", "Alt"]) {
      await user.keyboard(`{${key}>}`);
      await user.click(screen.getByRole("link", { name: /API Platform/ }));
      await user.keyboard(`{/${key}}`);
      expect(window.location.pathname, key).toBe("/");
    }
  });

  it("holds the table's place while loading", () => {
    wrap(<StatusTableSkeleton />);
    expect(document.querySelector('[aria-busy="true"]')).toBeInTheDocument();
  });
});

describe("small pieces", () => {
  it("puts uptime figures in the product's columns, named after their region, windows in words", () => {
    const windows = {
      columns: ["7d", "30d", "12mo"],
      region: new Set(["7d", "12mo"]),
      component: new Set(["30d"]),
    };
    wrap(
      <ProductUptime.Provider value={windows}>
        <UptimeFigures
          uptime={[
            { window: "12mo", percent: 99.994 },
            { window: "7d", percent: 100 },
          ]}
          label="Uptime for EU"
          kind="region"
        />
      </ProductUptime.Provider>,
    );
    const group = screen.getByRole("group", { name: "Uptime for EU" });
    // In column order, the 30d column left blank.
    expect(
      within(group)
        .getAllByRole("term")
        .map((t) => t.textContent),
    ).toEqual(["7 days", "12 months"]);
    expect(
      within(group)
        .getAllByRole("definition")
        .map((d) => d.textContent),
    ).toEqual(["100%", "99.994%"]);
    expect(group.querySelector("dl")?.children).toHaveLength(3);
    expect(windowName("12mo")).toBe("12 months");
    expect(windowName("1d")).toBe("1 day");
    expect(windowName("ytd")).toBe("ytd");
  });

  it("shows a muted dash where a row's kind publishes a window the source sent no figure for", () => {
    const windows = {
      columns: ["7d", "30d", "90d", "12mo"],
      region: new Set(["7d", "30d", "90d", "12mo"]),
      component: new Set(["30d", "90d"]),
    };
    wrap(
      <ProductUptime.Provider value={windows}>
        <UptimeFigures uptime={[]} label="Uptime for Test Agent" kind="component" />
      </ProductUptime.Provider>,
    );
    const group = screen.getByRole("group", { name: "Uptime for Test Agent" });
    // Only the component columns: 7d and 12mo stay blank, as for every component.
    expect(
      within(group)
        .getAllByRole("definition")
        .map((d) => d.textContent),
    ).toEqual(["-not published", "-not published"]);
    expect(
      within(group)
        .getAllByRole("term")
        .map((t) => t.textContent),
    ).toEqual(["30 days", "90 days"]);
    expect(within(group).getAllByText("-")[0]).toHaveAttribute("aria-hidden", "true");
  });

  it("orders a product's uptime columns by length, and tells regions' windows from components'", () => {
    const region = (windows: string[], component: string[] = []) => ({
      id: "r",
      name: "R",
      status: "operational" as const,
      uptime: windows.map((w) => ({ window: w, percent: 100 })),
      groups: [
        {
          name: "G",
          status: "operational" as const,
          components: [
            {
              name: "C",
              status: "operational" as const,
              uptime: component.map((w) => ({ window: w, percent: 100 })),
            },
          ],
        },
      ],
    });
    const windows = uptimeWindows([region(["12mo", "7d"]), region(["90d"], ["30d", "ytd"])]);
    expect(windows.columns).toEqual(["7d", "30d", "90d", "12mo", "ytd"]);
    expect([...windows.region]).toEqual(["12mo", "7d", "90d"]);
    expect([...windows.component]).toEqual(["30d", "ytd"]);
  });

  it("formats uptime percentages", () => {
    expect(formatPercent(99.99412)).toBe("99.994%");
    expect(formatPercent(100)).toBe("100%");
    const { container } = wrap(<UptimeFigures uptime={[]} label="none" kind="region" />);
    expect(container).toBeEmptyDOMElement();
  });

  it("renders a status as icon plus text and a loading skeleton", () => {
    wrap(
      <>
        <StatusLabel status="maintenance">Under maintenance</StatusLabel>
        <ProductListSkeleton />
      </>,
    );
    expect(screen.getByText("Under maintenance")).toBeInTheDocument();
    expect(document.querySelector('[aria-busy="true"]')).toBeInTheDocument();
  });

  it("shows a plain message when rendering throws, and the title stops naming a status", () => {
    const Boom = (): never => {
      throw new Error("boom");
    };
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    document.title = "All systems operational - WSO2 Cloud Status";
    render(
      <ErrorBoundary>
        <Boom />
      </ErrorBoundary>,
    );
    expect(screen.getByRole("alert")).toHaveTextContent("Something went wrong");
    // Nothing polls while the boundary shows, so the last status cannot stay in the tab.
    expect(document.title).toBe("Something went wrong showing this page - WSO2 Cloud Status");
    expect(screen.getByRole("alert")).toHaveTextContent("This page will try again on its own.");
    expect(screen.queryByRole("link")).toBeNull();
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });

  it("renders the page again after a summary interval, so a crashed tab recovers", () => {
    vi.useFakeTimers();
    let broken = true;
    const Flaky = () => {
      if (broken) throw new Error("bad data");
      return <p>Status is back</p>;
    };
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    render(
      <ErrorBoundary>
        <Flaky />
      </ErrorBoundary>,
    );
    expect(screen.getByRole("alert")).toHaveTextContent("will try again on its own");
    broken = false;
    act(() => {
      vi.advanceTimersByTime(30_000);
    });
    expect(screen.getByText("Status is back")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).toBeNull();
    spy.mockRestore();
    vi.useRealTimers();
  });
});

describe("formatPercent", () => {
  it.each([
    [100, "100%"],
    [100.2, "100%"],
    [99.9996, "99.999%"],
    [99.994, "99.994%"],
    [99.9945, "99.994%"],
    [99.9, "99.9%"],
    [99.99999999, "99.999%"],
    [0, "0%"],
    [-3, "0%"],
    [Number.NaN, "0%"],
    [1e-9, "0%"],
    [50, "50%"],
    [99.5, "99.5%"],
  ])("%s reads %s", (value, text) => {
    expect(formatPercent(value)).toBe(text);
  });
});
