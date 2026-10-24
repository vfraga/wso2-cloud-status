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

import { expect, test, type Page } from "@playwright/test";
import { rmSync } from "node:fs";
import { join } from "node:path";
import {
  ALL_BUT_ONE_OPERATIONAL,
  expectNoSeriousViolations,
  expectNoSeriousViolationsOnPhone,
  productRows,
  ready,
  readyProduct,
  shotPath,
} from "../helpers";

// scripts/e2e.sh runs this scenario with 5 s polls and stale_after 10s (a 15 s budget
// per kind of data) and sets E2E_FIXTURE_DIR to the directory the upstream reads on
// every request. Once every source has answered, the specs remove Moesif's incidents
// and Agent Platform's component statuses: two feeds that stop after answering.
const fixtures = process.env.E2E_FIXTURE_DIR;
// The UTC clock in the en-US locale the suite runs in, "2:05 PM UTC", and the date before it.
const CLOCK = String.raw`\d{1,2}:\d\d\s[AP]M UTC`;
const DATE = String.raw`\w{3} \d{1,2}, \d{4}`;

test.describe.configure({ mode: "serial" });

test.describe("feeds that stop after answering", () => {
  test.setTimeout(120_000);

  test.beforeAll(async ({ browser }) => {
    expect(fixtures, "E2E_FIXTURE_DIR is set by scripts/e2e.sh").toBeTruthy();
    const page = await browser.newPage();
    await ready(page);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("All systems operational");
    await page.close();
    rmSync(join(fixtures ?? "", "moesif.incidents.json"));
    rmSync(join(fixtures ?? "", "agent-manager.monitors.json"));
  });

  /** Reloads until both feeds are past their budget in what the page shows. */
  async function stopped(page: Page): Promise<void> {
    await expect(async () => {
      await ready(page);
      await expect(page.getByRole("heading", { level: 1 })).toHaveText(
        "Status unavailable for Agent Platform",
        { timeout: 2_000 },
      );
      await expect(page.getByText(/^Incidents last updated /)).toBeVisible({ timeout: 2_000 });
    }).toPass({ timeout: 60_000 });
  }

  test("the home page names both, keeps the others current, and says no more", async ({ page }) => {
    await stopped(page);
    const banner = page.getByRole("region", { name: "Overall status" });
    // The headline stays on component status; one secondary line for the incidents.
    await expect(banner).toContainText(ALL_BUT_ONE_OPERATIONAL);
    await expect(banner).toContainText(
      new RegExp(`Incident information for Moesif has not been updated since ${CLOCK}\\.`),
    );
    // The age line dates the other products; Agent Platform is named with its own
    // time, and nothing says the whole page may be out of date.
    await expect(banner.getByText(/^Other products checked /)).toBeVisible();
    await expect(page.getByRole("status")).toHaveText(
      new RegExp(`^Status data for Agent Platform was last checked at ${CLOCK}\\.$`),
    );
    // The row names the time.
    const moesif = productRows(page).filter({
      has: page.getByRole("heading", { level: 2, name: "Moesif" }),
    });
    await expect(
      // The short e2e budgets can make the feed stale within its first minute.
      moesif.getByText(
        new RegExp(`^Incidents last updated ${CLOCK} \\((\\d+ min ago|just now)\\)$`),
      ),
    ).toBeVisible();
    // Today, the day of the last successful fetch, has no incidents: No data, not green.
    await expect(moesif.getByRole("listbox").getByRole("option").last()).toHaveAccessibleName(
      new RegExp(`No data\\. Incident information complete only until ${CLOCK}\\.$`),
    );
    // Past incidents: the note with a link, and today speaks only for the others.
    const past = page.getByRole("region", { name: "Past incidents" });
    await expect(
      past.getByText(
        new RegExp(`^Incident information for Moesif is incomplete after ${DATE}, ${CLOCK}\\.`),
      ),
    ).toBeVisible();
    await expect(past.getByRole("link", { name: "See the Moesif status page" })).toHaveAttribute(
      "href",
      "https://status.moesif.com",
    );
    const today = past.getByRole("region").first();
    await expect(today.getByText("No incidents reported.", { exact: true })).toHaveCount(0);
    await page.screenshot({
      path: shotPath("e2e-stopped"),
      fullPage: true,
      animations: "disabled",
    });
    await expectNoSeriousViolations(page);
  });

  test("Moesif's page says the same, with no false empty incident list", async ({ page }) => {
    await expect(async () => {
      await readyProduct(page, "moesif", "Moesif");
      await expect(page.getByText(/^Incidents last updated /)).toBeVisible({ timeout: 2_000 });
    }).toPass({ timeout: 60_000 });
    await expect(page.getByRole("heading", { level: 1 })).toHaveAccessibleName(
      "Moesif: All systems operational",
    );
    await expect(page.getByRole("region", { name: "Overall status" })).toContainText(
      "Incident information for Moesif has not been updated since",
    );
    await expect(
      page.getByText(/^Incident information for Moesif is incomplete after /),
    ).toBeVisible();
    await expect(page.getByText("No incidents reported.")).toHaveCount(0);
    await expect(page.getByRole("listbox").getByRole("option").last()).toHaveAccessibleName(
      /Incident information complete only until/,
    );
    await page.screenshot({
      path: shotPath("e2e-stopped-product"),
      fullPage: true,
      animations: "disabled",
    });
  });

  test("axe finds no serious or critical issues at 360 px, home and product page", async ({
    browser,
  }) => {
    await expectNoSeriousViolationsOnPhone(browser, ready);
    await expectNoSeriousViolationsOnPhone(browser, (page) =>
      readyProduct(page, "moesif", "Moesif"),
    );
  });
});
