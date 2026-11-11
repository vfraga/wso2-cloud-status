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
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { part } from "../test/factories";
import { wrap } from "../test/render";
import { ThemeRoot } from "../theme/ThemeRoot";
import { LocationPanel, RegionDetailPanel } from "./RegionDetailPanel";
import { ProductUptime, uptimeWindows } from "./Uptime";

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

  it("words the location as the home table does: partial when some parts are out, major when all", () => {
    const outPart = (name: string, status: "outage" | "operational") => ({
      ...part(name, status),
      groups: [],
    });
    const { unmount } = wrap(
      <ul>
        <LocationPanel
          location={{ id: "eu", name: "EU", status: "outage" }}
          regions={[outPart("EU control plane", "operational"), outPart("EU data plane", "outage")]}
        />
      </ul>,
    );
    // The location rolls up; the plane that is out keeps CSM's words.
    expect(screen.getByText("Partial outage")).toBeInTheDocument();
    expect(screen.getAllByText("Service outage")).toHaveLength(1);
    unmount();
    wrap(
      <ul>
        <LocationPanel
          location={{ id: "eu", name: "EU", status: "outage" }}
          regions={[outPart("EU control plane", "outage"), outPart("EU data plane", "outage")]}
        />
      </ul>,
    );
    expect(screen.getByText("Major outage")).toBeInTheDocument();
    expect(screen.getAllByText("Service outage")).toHaveLength(2);
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
