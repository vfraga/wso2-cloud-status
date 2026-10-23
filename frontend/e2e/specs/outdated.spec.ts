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
  PRODUCT_NAMES,
  productRows,
  ready,
  readyProduct,
  shotPath,
} from "../helpers";

// The row line for a feed that never answered; one that answered names its time
// instead (see stopped.spec.ts).
const OUTDATED = "Incident information unavailable";

// scripts/e2e.sh runs this scenario with 5 s polls and stale_after 10s. Moesif's
// incidents never answer, so the API marks them stale from the start; the page
// polls the summary every 30 s, so the line shows within about 40 s at most.
test.describe("a source whose incidents never answer", () => {
  test.setTimeout(90_000);

  test("its product says its incident information is unavailable; the others do not", async ({
    page,
  }) => {
    await ready(page);
    const rows = productRows(page);
    const moesif = rows.filter({ has: page.getByRole("heading", { level: 2, name: "Moesif" }) });
    await expect(moesif.getByText(OUTDATED, { exact: true })).toBeVisible({ timeout: 40_000 });
    // With no time to name, the banner says the information is unavailable.
    const banner = page.getByRole("region", { name: "Overall status" });
    await expect(banner).toContainText("Incident information for Moesif is unavailable right now.");
    await expect(banner).not.toContainText("has not been updated");
    // The flag does not open the regions.
    await expect(moesif.getByRole("button", { name: /1 region/ })).toHaveAttribute(
      "aria-expanded",
      "false",
    );
    for (const name of PRODUCT_NAMES.filter((n) => n !== "Moesif")) {
      const row = rows.filter({ has: page.getByRole("heading", { level: 2, name }) });
      await expect(row.getByText(OUTDATED)).toHaveCount(0);
    }
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
