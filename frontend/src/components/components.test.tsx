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
import type { Incident, Status } from "../api/types";
import type { Headline } from "../lib/headline";
import { BANNER_LABEL } from "../lib/status";
import {
  formatClock,
  formatDateClock,
  formatHistoryDate,
  formatUtcClock,
  formatUtcDateTime,
} from "../lib/time";
import { apiTime, days, incident, locatedProduct, part, product } from "../test/factories";
import { Banner } from "./Banner";
import { HistoryStrip } from "./HistoryStrip";
import { IncidentItem } from "./IncidentMeta";
import { ProductRow } from "./ProductRow";
import { LocationPanel, RegionDetailPanel } from "./RegionDetailPanel";
import { Regions } from "./Regions";
import { ThemeRoot } from "../theme/ThemeRoot";
import { UptimeFigure, UptimeList, formatPercent } from "./UptimeList";
import { ErrorBoundary } from "./ErrorBoundary";
import { ProductListSkeleton } from "./Skeletons";
import { StatusLabel } from "./StatusIcon";
import { ActiveIncidents } from "./ActiveIncidents";
import { PastIncidents } from "./PastIncidents";
import { PageNowProvider } from "../hooks/useNow";

const wrap = (ui: React.ReactElement) => render(<ThemeRoot>{ui}</ThemeRoot>);

/** The incident list's polling state as HomePage passes it. */
function listState(incidents: Incident[] | null, failed: boolean) {
  return {
    incidents,
    checkedAt: null,
    lastSuccessAt: incidents === null ? null : new Date(),
    failed,
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("HistoryStrip", () => {
  const d = days(90, {
    88: { status: "degraded", minutes: { degraded: 95 }, incidentIds: ["inc-1"] },
    3: { status: "unknown" },
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
    expect(
      screen.getByText("90 days: 1 day with incidents, 1 day without data"),
    ).toBeInTheDocument();
    const options = screen.getAllByRole("option");
    expect(options).toHaveLength(90);
    expect(options.filter((o) => o.tabIndex === 0)).toHaveLength(1);

    await user.tab();
    await user.tab();
    expect(options[89]).toHaveFocus();
    await user.tab();
    expect(
      screen.getByRole("button", { name: "1 day with incidents for API Platform" }),
    ).toHaveFocus();
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
    const options = screen.getAllByRole("option");
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
    const options = screen.getAllByRole("option");
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
    await user.hover(screen.getAllByRole("option")[3]!);
    expect(screen.getByText("No data")).toBeInTheDocument();
    expect(document.activeElement).toBe(document.body);
    await user.keyboard("{Escape}");
    expect(screen.queryByText("No data")).not.toBeInTheDocument();
  });

  it("opens the tooltip below the strip, clear of the row's name and status", async () => {
    const user = userEvent.setup();
    wrap(<HistoryStrip productName="X" days={d} incidents={new Map()} />);
    await user.hover(screen.getAllByRole("option")[3]!);
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
    await user.hover(screen.getAllByRole("option")[3]!);
    const popper = document.querySelector(".MuiPopper-root");
    await waitFor(() => {
      expect(popper).toHaveAttribute("data-popper-placement", "bottom");
    });
    expect(scroll).not.toHaveBeenCalled();
    await user.unhover(screen.getAllByRole("option")[3]!);
    // A tap or the keyboard focuses the cell: the tooltip is brought into view.
    act(() => {
      screen.getAllByRole("option")[89]!.focus();
    });
    await waitFor(() => {
      expect(scroll).toHaveBeenCalledWith({ block: "nearest" });
    });
    scroll.mockRestore();
  });

  it("draws the days in system colours under forced colors", () => {
    wrap(<HistoryStrip productName="X" days={d} incidents={new Map()} />);
    const css = Array.from(document.querySelectorAll("style"))
      .map((el) => el.textContent)
      .join("\n");
    expect(css).toMatch(
      /@media \(forced-colors: active\)\{[^}]*forced-color-adjust:none;background-color:CanvasText/,
    );
    expect(css).toMatch(
      /forced-color-adjust:none;background-image:linear-gradient\(GrayText, GrayText\)/,
    );
    expect(css).toMatch(/background-image:repeating-linear-gradient\(45deg, GrayText/);
  });

  it("keeps the tooltip open while the pointer is on it (WCAG 1.4.13)", async () => {
    const user = userEvent.setup();
    wrap(<HistoryStrip productName="X" days={d} incidents={new Map()} />);
    await user.hover(screen.getAllByRole("option")[3]!);
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
    const options = screen.getAllByRole("option");
    expect(getComputedStyle(options[0]!).backgroundSize).toBe("100% 60%");
    expect(getComputedStyle(options[3]!).backgroundSize).toBe("100% 60%");
    expect(getComputedStyle(options[88]!).backgroundSize).not.toBe("100% 60%");
  });

  it("captions the number of days with incidents and lists them on request", async () => {
    const user = userEvent.setup();
    wrap(
      <HistoryStrip
        productName="API Platform"
        days={days(90, {
          10: { status: "outage", minutes: { outage: 62 } },
          88: { status: "degraded", minutes: { degraded: 95 }, incidentIds: ["inc-1"] },
        })}
        incidents={new Map([["inc-1", incident()]])}
      />,
    );
    const toggle = screen.getByRole("button", { name: "2 days with incidents for API Platform" });
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
    await user.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "false");
  });

  it("captions a quiet strip without a control", () => {
    const { rerender } = wrap(
      <HistoryStrip productName="X" days={days(30)} incidents={new Map()} />,
    );
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
    expect(screen.getByText("0 days with incidents")).toBeInTheDocument();
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
      screen.getByRole("listbox", { name: "90-day history for API Platform, UTC days" }),
    ).toBeInTheDocument();
    expect(screen.getAllByRole("option")[89]).toHaveAccessibleName(
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
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
  });
});

describe("Regions", () => {
  it("is collapsed when operational and complete, and the user can toggle", async () => {
    const user = userEvent.setup();
    wrap(<Regions product={product()} trailing={null} />);
    const toggle = screen.getByRole("button", { name: /2 regions/ });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(toggle).not.toHaveAttribute("aria-controls");
    await user.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    const panel = document.getElementById(toggle.getAttribute("aria-controls") ?? "");
    expect(panel).toContainElement(screen.getByText("EU"));
    await user.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(toggle).not.toHaveAttribute("aria-controls");
  });

  it("opens itself when degraded or incomplete, and links only regions with their own page", () => {
    wrap(<Regions product={product({ status: "degraded" })} trailing={null} />);
    expect(screen.getByRole("button", { name: /2 regions/ })).toHaveAttribute(
      "aria-expanded",
      "true",
    );
    expect(screen.getAllByRole("link")).toHaveLength(1);
    expect(screen.getByRole("link", { name: "Status page for EU, API Platform" })).toHaveAttribute(
      "href",
      "https://status.example.test/eu",
    );
  });

  it("stays closed when every region only repeats the product's unavailable status", () => {
    const regions = product().regions.map((r) => ({ ...r, status: "unknown" as const }));
    wrap(
      <Regions
        product={product({ status: "unknown", dataComplete: false, regions })}
        trailing={null}
      />,
    );
    expect(screen.getByRole("button", { name: /2 regions/ })).toHaveAttribute(
      "aria-expanded",
      "false",
    );
  });

  it("opens for a region whose data is missing and re-opens when the product degrades after a manual close", async () => {
    const user = userEvent.setup();
    const [us, eu] = product().regions;
    const partial = product({
      dataComplete: false,
      regions: [us!, { ...eu!, status: "unknown" }],
    });
    const { rerender } = wrap(<Regions product={partial} trailing={null} />);
    const toggle = screen.getByRole("button", { name: /2 regions/ });
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    await user.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    rerender(
      <ThemeRoot>
        <Regions product={product({ dataComplete: true })} trailing={null} />
      </ThemeRoot>,
    );
    expect(screen.getByRole("button", { name: /2 regions/ })).toHaveAttribute(
      "aria-expanded",
      "false",
    );
    rerender(
      <ThemeRoot>
        <Regions product={product({ status: "outage" })} trailing={null} />
      </ThemeRoot>,
    );
    expect(screen.getByRole("button", { name: /2 regions/ })).toHaveAttribute(
      "aria-expanded",
      "true",
    );
  });

  it("handles one region and none", () => {
    wrap(<Regions product={product({ regions: [] })} trailing={<span>link</span>} />);
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
    expect(screen.getByText("link")).toBeInTheDocument();
  });

  it("uses the singular", () => {
    wrap(
      <Regions
        product={product({
          regions: [{ id: "us", name: "US", status: "operational", pageUrl: "", uptime: [] }],
        })}
        trailing={null}
      />,
    );
    expect(screen.getByRole("button", { name: /1 region$/ })).toBeInTheDocument();
  });
});

describe("Regions by location", () => {
  it("lists places that open into their parts, each part with its 90-day uptime", async () => {
    const user = userEvent.setup();
    wrap(<Regions product={locatedProduct()} trailing={null} />);
    await user.click(screen.getByRole("button", { name: /^2 regions/ }));
    const us = screen.getByRole("button", { name: /^US/ });
    expect(us).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByText("Control plane")).not.toBeInTheDocument();
    await user.click(us);
    const panel = document.getElementById(us.getAttribute("aria-controls") ?? "");
    const parts = within(panel!).getAllByRole("listitem");
    expect(parts.map((li) => li.firstElementChild?.textContent)).toEqual([
      "Control plane",
      "Data plane",
    ]);
    // The figure as the upstream reports it, and words for a screen reader.
    expect(within(parts[0]!).getByText("99.994% (90d)")).toHaveAttribute("aria-hidden", "true");
    expect(within(parts[0]!).getByText("90-day uptime 99.994%")).toBeInTheDocument();
    expect(within(parts[1]!).getByText("100% (90d)")).toBeInTheDocument();
  });

  it("opens the place whose part has a problem, and counts places as regions", () => {
    const degraded = locatedProduct({
      status: "degraded",
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
    wrap(
      <ul>
        <ProductRow product={degraded} incidents={new Map()} />
      </ul>,
    );
    expect(screen.getByText("1 of 2 regions affected")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^2 regions/ })).toHaveAttribute(
      "aria-expanded",
      "true",
    );
    expect(screen.getByRole("button", { name: /^EU/ })).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("button", { name: /^US/ })).toHaveAttribute("aria-expanded", "false");
    expect(screen.getByText("Data plane")).toBeInTheDocument();
  });

  it("lists a part whose place it cannot read on its own, under its full name", async () => {
    const user = userEvent.setup();
    wrap(
      <Regions
        product={locatedProduct({
          locations: [{ id: "us", name: "US", status: "operational" }],
          regions: [part("US control plane"), part("EU data plane")],
        })}
        trailing={null}
      />,
    );
    await user.click(screen.getByRole("button", { name: /^2 regions/ }));
    expect(screen.getByRole("button", { name: /^US/ })).toBeInTheDocument();
    expect(screen.getByText("EU data plane")).toBeInTheDocument();
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

describe("UptimeFigure", () => {
  it("shows the 90-day figure, or nothing without one", () => {
    const { container, rerender } = wrap(
      <UptimeFigure uptime={[{ window: "90d", percent: 99.9996 }]} />,
    );
    expect(screen.getByText("99.999% (90d)")).toBeInTheDocument();
    rerender(
      <ThemeRoot>
        <UptimeFigure uptime={[{ window: "30d", percent: 100 }]} />
      </ThemeRoot>,
    );
    expect(container).toHaveTextContent("");
  });
});

describe("RegionDetailPanel", () => {
  const region = {
    id: "eu",
    name: "EU",
    status: "operational" as const,
    pageUrl: "",
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
    await user.click(toggle);
    expect(toggle).not.toHaveAttribute("aria-controls");
  });
});

describe("RegionDetailPanel without components", () => {
  it("shows the name as plain text, never an empty panel, and says why when nothing is known", () => {
    const { rerender } = wrap(
      <ul>
        <RegionDetailPanel
          region={{ id: "us", name: "US", status: "unknown", pageUrl: "", uptime: [], groups: [] }}
        />
      </ul>,
    );
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 3, name: "US" })).toBeInTheDocument();
    expect(screen.getByText("No component data is available right now.")).toBeInTheDocument();
    rerender(
      <ThemeRoot>
        <ul>
          <RegionDetailPanel
            region={{
              id: "us",
              name: "US",
              status: "operational",
              pageUrl: "",
              uptime: [{ window: "7d", percent: 100 }],
              groups: [],
            }}
          />
        </ul>
      </ThemeRoot>,
    );
    expect(screen.queryByText("No component data is available right now.")).not.toBeInTheDocument();
    expect(screen.getByText("Uptime (outages only, updated daily)")).toBeInTheDocument();
  });
});

describe("ProductRow", () => {
  it("renders the description, the status page link and no region count when healthy", () => {
    wrap(
      <ul>
        <ProductRow product={product({ description: "Bijira" })} incidents={new Map()} />
      </ul>,
    );
    expect(screen.getByText("Bijira")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "View status page for API Platform" })).toHaveAttribute(
      "href",
      "https://status.example.test/api",
    );
    expect(screen.getByRole("link", { name: "API Platform" })).toHaveAttribute(
      "href",
      "/products/api-platform",
    );
    expect(screen.queryByText(/regions affected/)).not.toBeInTheDocument();
  });

  it("renders nothing for an absent description", () => {
    wrap(
      <ul>
        <ProductRow product={product()} incidents={new Map()} />
      </ul>,
    );
    expect(screen.queryByText("Bijira")).not.toBeInTheDocument();
  });

  it("states how many regions are affected, with icon and text", () => {
    wrap(
      <ul>
        <ProductRow
          product={product({
            status: "degraded",
            regions: [
              { id: "us", name: "US", status: "operational", pageUrl: "", uptime: [] },
              { id: "eu", name: "EU", status: "degraded", pageUrl: "", uptime: [] },
            ],
          })}
          incidents={new Map()}
        />
      </ul>,
    );
    expect(screen.getByText("1 of 2 regions affected")).toBeInTheDocument();
    expect(screen.getAllByText("Degraded performance").length).toBeGreaterThan(0);
  });

  it("labels an operational product with missing data as unavailable, not Operational", () => {
    const { rerender } = wrap(
      <ul>
        <ProductRow
          product={product({
            dataComplete: false,
            regions: [
              { id: "us", name: "US", status: "operational", pageUrl: "", uptime: [] },
              { id: "eu", name: "EU", status: "unknown", pageUrl: "", uptime: [] },
            ],
          })}
          incidents={new Map()}
        />
      </ul>,
    );
    expect(screen.getByText("Some data unavailable")).toBeInTheDocument();
    // Only the US region reads Operational; the product does not.
    expect(screen.getAllByText("Operational")).toHaveLength(1);
    expect(screen.getByText("1 of 2 regions unavailable")).toBeInTheDocument();
    expect(screen.queryByText(/last updated|^Incident information|^Uptime/)).toBeNull();
    // Every region known, a component unknown.
    rerender(
      <ThemeRoot>
        <ul>
          <ProductRow product={product({ dataComplete: false })} incidents={new Map()} />
        </ul>
      </ThemeRoot>,
    );
    expect(screen.getByText("Some component data is unavailable")).toBeInTheDocument();
  });

  it("keeps a problem status and adds the missing regions under it", () => {
    wrap(
      <ul>
        <ProductRow
          product={product({
            status: "degraded",
            dataComplete: false,
            regions: [
              { id: "us", name: "US", status: "degraded", pageUrl: "", uptime: [] },
              { id: "eu", name: "EU", status: "unknown", pageUrl: "", uptime: [] },
            ],
          })}
          incidents={new Map()}
        />
      </ul>,
    );
    expect(screen.getAllByText("Degraded performance").length).toBeGreaterThan(0);
    expect(screen.getByText("1 of 2 regions affected")).toBeInTheDocument();
    expect(screen.getByText("1 of 2 regions unavailable")).toBeInTheDocument();
  });

  it("says which feeds are stale at any status, and since when", () => {
    const stopped = apiTime(20 * 60_000);
    const incidentsStale = {
      checkedAt: { components: apiTime(), incidents: stopped, uptime: apiTime() },
      stale: { components: false, incidents: true, uptime: false },
    };
    const { rerender } = wrap(
      <ul>
        <ProductRow
          product={product({
            status: "outage",
            regions: [
              { id: "us", name: "US", status: "outage", pageUrl: "", uptime: [] },
              { id: "eu", name: "EU", status: "degraded", pageUrl: "", uptime: [] },
            ],
            freshness: incidentsStale,
          })}
          incidents={new Map()}
        />
      </ul>,
    );
    expect(
      screen.getByText(/^Incidents last updated \S.* UTC \(2\d min ago\)$/),
    ).toBeInTheDocument();
    expect(screen.getByText("2 of 2 regions affected")).toBeInTheDocument();
    rerender(
      <ThemeRoot>
        <ul>
          <ProductRow
            product={product({
              dataComplete: false,
              freshness: {
                checkedAt: { components: apiTime(), incidents: null, uptime: null },
                stale: { components: false, incidents: true, uptime: true },
              },
            })}
            incidents={new Map()}
          />
        </ul>
      </ThemeRoot>,
    );
    expect(screen.getByText("Some data unavailable")).toBeInTheDocument();
    expect(screen.getByText("Incident information unavailable")).toBeInTheDocument();
    // The home row shows each region's uptime, so it names a feed that never answered.
    expect(screen.getByText("Uptime unavailable")).toBeInTheDocument();
  });

  it("does not open the regions of a product with stale feeds that is otherwise healthy", () => {
    wrap(
      <ul>
        <ProductRow
          product={product({
            freshness: {
              checkedAt: { components: apiTime(), incidents: null, uptime: apiTime() },
              stale: { components: false, incidents: true, uptime: false },
            },
          })}
          incidents={new Map()}
        />
      </ul>,
    );
    expect(screen.getByText("Incident information unavailable")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /2 regions/ })).toHaveAttribute(
      "aria-expanded",
      "false",
    );
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
    expect(screen.getByText("Status checked less than a minute ago")).toBeInTheDocument();
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
    const { rerender } = wrap(<Banner {...base} loading headline={headline("unknown")} />);
    const live = screen.getByRole("status");
    rerender(
      <ThemeRoot>
        <Banner {...base} headline={headline("operational")} />
      </ThemeRoot>,
    );
    expect(live).toBeEmptyDOMElement();
    rerender(
      <ThemeRoot>
        <Banner {...base} headline={headline("outage")} />
      </ThemeRoot>,
    );
    expect(live).toHaveTextContent("Status changed: Service outage.");
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Service outage");
  });

  it("puts the headline in the document title when asked to", () => {
    const { rerender } = wrap(<Banner {...base} loading titled headline={headline("unknown")} />);
    expect(document.title).toBe("WSO2 Cloud Status");
    rerender(
      <ThemeRoot>
        <Banner {...base} titled headline={headline("degraded")} />
      </ThemeRoot>,
    );
    expect(document.title).toBe("Degraded performance - WSO2 Cloud Status");
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

  it("links an active incident to its product here and to the updates on its own page", () => {
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
    expect(
      screen.getByRole("link", { name: "Updates on the API Platform status page" }),
    ).toHaveAttribute("href", "https://status.example.test/api");
    expect(screen.getByText("Degraded performance")).toBeInTheDocument();
  });

  it("groups past incidents by day, with 'No incidents reported.' on empty days", () => {
    const today = new Date();
    wrap(
      <PastIncidents
        state={listState([incident({ startedAt: today, resolvedAt: today })], false)}
        products={[product()]}
      />,
    );
    expect(screen.getByRole("heading", { level: 2, name: "Past incidents" })).toBeInTheDocument();
    expect(screen.getAllByRole("heading", { level: 3 }).length).toBeGreaterThanOrEqual(14);
    expect(screen.getAllByText("No incidents reported.")).toHaveLength(13);
    expect(screen.getByRole("link", { name: "Full history for API Platform" })).toBeInTheDocument();
    const nav = screen.getByRole("navigation", { name: "Full incident history" });
    expect(within(nav).getAllByRole("link")).toHaveLength(1);
  });

  it("vouches for no day after the list's data stopped, and stops ongoing durations there", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(2026, 9, 21, 9, 0));
    const stopped = new Date(2026, 9, 19, 12, 0);
    const state = (incidents: Incident[]) => ({
      ...listState(incidents, true),
      lastSuccessAt: stopped,
      knownUntil: stopped,
    });
    const { rerender } = wrap(<PastIncidents state={state([])} products={[product()]} />);
    // The 19th to the 21st end after the data stopped; the 11 days before are covered.
    expect(screen.getAllByText("No incident information is available.")).toHaveLength(3);
    expect(screen.getAllByText("No incidents reported.")).toHaveLength(11);
    // The refresh failed long ago, so the note does not say "just now".
    expect(
      screen.getByText(/^Past incidents were last refreshed more than 5 minutes ago/),
    ).toBeInTheDocument();
    const open = incident({
      startedAt: new Date(2026, 9, 19, 11, 0),
      resolvedAt: null,
      state: "investigating",
    });
    rerender(
      <ThemeRoot>
        <PastIncidents state={state([open])} products={[product()]} />
      </ThemeRoot>,
    );
    expect(screen.getAllByText(/Ongoing for at least 1h\. Last known as of /)).toHaveLength(3);
  });

  it("says a failure is new on this browser's clock, whatever the server's", () => {
    // This browser is 10 minutes behind the server; its last success was a minute ago.
    const skewMs = -10 * 60_000;
    wrap(
      <PageNowProvider skewMs={skewMs}>
        <PastIncidents
          state={{ ...listState([], true), lastSuccessAt: new Date(Date.now() - 60_000), skewMs }}
          products={[product()]}
        />
      </PageNowProvider>,
    );
    expect(screen.getByText(/^Past incidents could not be refreshed just now/)).toBeInTheDocument();
  });

  it("lists an incident that started the evening before under today too, with its start date", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(2026, 9, 21, 9, 0));
    const started = new Date(2026, 9, 20, 23, 50);
    const open = incident({ startedAt: started, resolvedAt: null, state: "investigating" });
    wrap(<PastIncidents state={listState([open], false)} products={[product()]} />);
    const [today, yesterday] = screen
      .getAllByRole("region")
      .filter((r) => r.getAttribute("aria-labelledby")?.startsWith("day-"));
    expect(today).toHaveTextContent("Elevated latency");
    expect(today).not.toHaveTextContent("No incidents reported.");
    expect(within(today!).getByText(formatDateClock(started))).toBeInTheDocument();
    expect(within(yesterday!).getByText(formatClock(started))).toBeInTheDocument();
    expect(screen.getAllByText("No incidents reported.")).toHaveLength(12);
  });

  it("names a product whose incident data is unavailable, and speaks for the others only", () => {
    const missing = product({
      id: "moesif",
      name: "Moesif",
      pageUrl: "https://status.example.test/moesif",
      freshness: {
        checkedAt: { components: apiTime(), incidents: null, uptime: apiTime() },
        stale: { components: false, incidents: true, uptime: false },
      },
    });
    const { rerender } = wrap(
      <PastIncidents
        state={listState([], false)}
        products={[product(), product({ id: "x", name: "X" }), missing]}
      />,
    );
    expect(
      screen.getByText("Incident information for Moesif is unavailable right now."),
    ).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "See the Moesif status page" })).toHaveAttribute(
      "href",
      "https://status.example.test/moesif",
    );
    expect(screen.getAllByText("No incidents reported for the other products.")).toHaveLength(14);
    rerender(
      <ThemeRoot>
        <PastIncidents state={listState([], false)} products={[product(), missing]} />
      </ThemeRoot>,
    );
    expect(screen.getAllByText("No incidents reported for the other product.")).toHaveLength(14);
    rerender(
      <ThemeRoot>
        <PastIncidents state={listState([], false)} products={[missing]} />
      </ThemeRoot>,
    );
    expect(screen.getAllByText("No incident information is available.")).toHaveLength(14);
  });

  it("reports loading and failure of the incident list", () => {
    const { rerender } = wrap(<PastIncidents state={listState(null, false)} products={[]} />);
    expect(screen.getByText("Loading past incidents.")).toBeInTheDocument();
    rerender(
      <ThemeRoot>
        <PastIncidents state={listState(null, true)} products={[]} />
      </ThemeRoot>,
    );
    expect(screen.getByText("Past incidents could not be loaded.")).toBeInTheDocument();
    // The list is in, the summary is not: which days it covers is not known yet.
    rerender(
      <ThemeRoot>
        <PastIncidents state={listState([], false)} products={null} />
      </ThemeRoot>,
    );
    expect(screen.getByText("Loading past incidents.")).toBeInTheDocument();
    expect(screen.queryByText("No incidents reported.")).toBeNull();
  });
});

describe("small pieces", () => {
  it("labels uptime figures in full, or briefly under a region that already says it", () => {
    const { rerender } = wrap(<UptimeList uptime={[{ window: "7d", percent: 100 }]} label="EU" />);
    expect(screen.getByText("Uptime (outages only, updated daily)")).toBeInTheDocument();
    expect(screen.getByRole("definition")).toHaveTextContent("100%");
    rerender(
      <ThemeRoot>
        <UptimeList uptime={[{ window: "7d", percent: 100 }]} label="Gateway" short />
      </ThemeRoot>,
    );
    expect(screen.getByText("Uptime")).toBeInTheDocument();
  });

  it("formats uptime percentages", () => {
    expect(formatPercent(99.99412)).toBe("99.994%");
    expect(formatPercent(100)).toBe("100%");
    const { container } = wrap(<UptimeList uptime={[]} label="none" />);
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
    expect(screen.getByLabelText("Loading products")).toHaveAttribute("aria-busy", "true");
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
    expect(screen.getByRole("link", { name: "API Platform status page" })).toHaveAttribute(
      "href",
      "https://status.bijira.dev",
    );
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
