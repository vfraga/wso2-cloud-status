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

import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { wrap } from "../test/render";
import { HistoryLegend } from "./HistoryLegend";

describe("HistoryLegend", () => {
  it("names every colour and describes it on focus, Enter and hover, closing on Escape", async () => {
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
