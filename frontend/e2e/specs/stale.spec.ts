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
  ALL_BUT_ONE_OPERATIONAL,
  expectNoSeriousViolations,
  expectNoSeriousViolationsOnPhone,
  productRows,
  ready,
  readyProduct,
  shotPath,
} from "../helpers";

test.describe("a source that never answers", () => {
  test("its product reports no data in the banner and its row; the others stay operational", async ({
    page,
  }) => {
    await ready(page);
    // Grey, and named: never "All systems operational" over a product without data.
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(
      "Status unavailable for Moesif",
    );
    const banner = page.getByRole("region", { name: "Overall status" });
    await expect(banner).toContainText(ALL_BUT_ONE_OPERATIONAL);
    // The age line dates the other products; Moesif is named once, in the notice, and
    // nothing says the whole page may be out of date.
    await expect(banner.getByText(/^Other products checked /)).toBeVisible();
    await expect(page.getByRole("status")).toHaveText(
      "No status data has been received yet for Moesif.",
    );
    // Its row says so in the place it runs in; the other products stay operational.
    const moesif = productRows(page).filter({
      has: page.getByRole("link", { name: "Moesif", exact: true }),
    });
    await expect(moesif.getByRole("cell").first()).toContainText("Status unavailable");
    await expect(
      productRows(page).getByRole("cell").filter({ hasText: "Status unavailable" }),
    ).toHaveCount(1);
    await page.screenshot({ path: shotPath("e2e-stale"), fullPage: true, animations: "disabled" });
  });

  test("the product page has no empty region panel and no false empty incident list", async ({
    page,
  }) => {
    await readyProduct(page, "moesif", "Moesif");
    await expect(page.getByRole("heading", { level: 1 })).toHaveAccessibleName(
      "Moesif: Status unavailable",
    );
    // No age line beside a product with no data.
    const banner = page.getByRole("region", { name: "Overall status" });
    await expect(banner.getByText(/^Status checked /)).toHaveCount(0);
    await expect(page.getByRole("status")).toHaveText(
      "No status data has been received yet for Moesif.",
    );
    const regions = page.getByRole("region", { name: "Regions" });
    await expect(regions.getByRole("heading", { level: 3, name: "US" })).toBeVisible();
    await expect(regions.getByRole("button")).toHaveCount(0);
    await expect(regions.getByText("No component data is available right now.")).toBeVisible();
    await expect(
      page.getByText("Incident information for Moesif is unavailable right now."),
    ).toBeVisible();
    await expect(page.getByText("No incidents reported.")).toHaveCount(0);
    // Its incidents and uptime never answered: no time to name.
    await expect(page.getByText("Incident information unavailable", { exact: true })).toBeVisible();
    await expect(page.getByText("Uptime unavailable", { exact: true })).toBeVisible();
    await expect(
      page.getByRole("region", { name: "History" }).getByRole("gridcell").first(),
    ).toHaveAccessibleName(/No data/);
    await page.screenshot({
      path: shotPath("e2e-stale-product"),
      fullPage: true,
      animations: "disabled",
    });
  });

  test("axe finds no serious or critical issues", async ({ page }) => {
    await ready(page);
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
