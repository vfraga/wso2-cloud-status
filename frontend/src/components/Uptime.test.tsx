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

import { screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { wrap } from "../test/render";
import { ProductUptime, UptimeFigures, formatPercent, uptimeWindows, windowName } from "./Uptime";

describe("Uptime", () => {
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
