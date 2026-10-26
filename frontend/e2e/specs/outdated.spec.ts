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

import { expect, test } from "@playwright/test";
import {
  expectNoSeriousViolations,
  expectNoSeriousViolationsOnPhone,
  productRows,
  ready,
  readyProduct,
  shotPath,
} from "../helpers";

// The product page's line for a feed that never answered; one that answered names
// its time instead (see stopped.spec.ts).
const OUTDATED = "Incident information unavailable";

// scripts/e2e.sh runs this scenario with 5 s polls and stale_after 10s. Moesif's
// incidents never answer, so the API marks them stale from the start; the page
// polls the summary every 30 s, so the banner says so within about 40 s at most.
test.describe("a source whose incidents never answer", () => {
  test.setTimeout(90_000);

  test("the banner says its incident information is unavailable; statuses stay as they are", async ({
    page,
  }) => {
    await ready(page);
    // With no time to name, the banner says the information is unavailable.
    const banner = page.getByRole("region", { name: "Overall status" });
    await expect(banner).toContainText(
      "Incident information for Moesif is unavailable right now.",
      { timeout: 40_000 },
    );
    await expect(banner).not.toContainText("has not been updated");
    // Missing incidents do not make a status unknown: every product stays operational.
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("All systems operational");
    await expect(
      productRows(page).getByRole("cell").filter({ hasText: "Status unavailable" }),
    ).toHaveCount(0);
    await page.screenshot({
      path: shotPath("e2e-outdated"),
      fullPage: true,
      animations: "disabled",
    });
    await expectNoSeriousViolations(page);
  });

  test("the product page carries the same flag", async ({ page }) => {
    await page.goto("/products/moesif");
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(/^Moesif: /);
    await expect(async () => {
      await page.reload();
      await expect(page.getByText(OUTDATED, { exact: true })).toBeVisible({ timeout: 2_000 });
    }).toPass({ timeout: 40_000 });
    // Its incidents never answered: the page says so instead of "No incidents
    // reported", in Recent incidents and in the banner.
    const sentence = "Incident information for Moesif is unavailable right now.";
    await expect(
      page.getByRole("region", { name: "Recent incidents" }).getByText(sentence),
    ).toBeVisible();
    await expect(
      page.getByRole("region", { name: "Overall status" }).getByText(sentence),
    ).toBeVisible();
    await expect(page.getByText("No incidents reported.")).toHaveCount(0);
    await expectNoSeriousViolations(page);
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
