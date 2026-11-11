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
  collectConsoleErrors,
  PRODUCT_NAMES,
  PRODUCTS,
  productRows,
  ready,
  readyProduct,
} from "../helpers";

test.describe("all operational", () => {
  test("shows each product's status per region in a table, with no console errors", async ({
    page,
  }) => {
    const errors = collectConsoleErrors(page);
    await ready(page);
    // A background tab shows the site's name; the status is the h1.
    await expect(page).toHaveTitle("WSO2 Cloud Status");
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("All systems operational");
    const table = page.getByRole("table", { name: "Current status of each product by region" });
    await expect(table.getByRole("columnheader")).toHaveText(["Product", "US", "EU"]);
    const rows = productRows(page);
    await expect(rows).toHaveCount(PRODUCTS);
    await expect(rows.getByRole("rowheader").getByRole("link")).toHaveText(PRODUCT_NAMES);
    // Every place a product runs in is operational; the others are marked as
    // not its regions. Where each product runs comes from the API, so a new
    // product changes no number here.
    const summary = (await (await page.request.get("/api/v1/summary")).json()) as {
      products: { locations: { name: string }[]; regions: { name: string; location?: string }[] }[];
    };
    const runsIn = summary.products.map(
      (p) =>
        new Set([
          ...p.locations.map((l) => l.name),
          ...p.regions.filter((r) => r.location === undefined).map((r) => r.name),
        ]),
    );
    const placesRun = runsIn.reduce((n, places) => n + places.size, 0);
    const cells = rows.getByRole("cell");
    await expect(cells).toHaveCount(2 * PRODUCTS);
    await expect(cells.filter({ hasText: "Operational" })).toHaveCount(placesRun);
    await expect(cells.filter({ hasText: "No EU region" })).toHaveCount(
      runsIn.filter((places) => !places.has("EU")).length,
    );
    // The detail is on each product's page.
    await expect(page.getByRole("grid")).toHaveCount(0);
    await expect(page.getByRole("heading", { name: "Past incidents" })).toHaveCount(0);
    await expect(page.getByText(/^Status checked /).first()).toBeVisible();
    expect(errors).toEqual([]);
  });

  test("opens a product from its name, or from anywhere on its row", async ({ page }) => {
    await ready(page);
    const first = productRows(page).first();
    await first.getByRole("cell").first().click();
    await expect(page).toHaveURL(/\/products\/agent-platform$/);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(
      /^Agent Platform \(Agent Manager\): /,
    );
    await page.getByRole("link", { name: "All products" }).click();
    await productRows(page).nth(1).getByRole("link", { name: "API Platform" }).click();
    await expect(page).toHaveURL(/\/products\/api-platform$/);
  });

  test("has no horizontal scroll at 360 px, and the product page shows a 30-day strip", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 360, height: 800 });
    await ready(page);
    const overflow = () =>
      page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      );
    expect(await overflow()).toBeLessThanOrEqual(0);
    // On a phone each row puts its places side by side under the product's name.
    const row = await productRows(page).nth(1).boundingBox();
    const cells = productRows(page).nth(1).getByRole("cell");
    const [us, eu] = [await cells.nth(0).boundingBox(), await cells.nth(1).boundingBox()];
    expect(us?.y).toBe(eu?.y);
    expect((eu?.x ?? 0) + (eu?.width ?? 0)).toBeLessThanOrEqual((row?.x ?? 0) + (row?.width ?? 0));
    await readyProduct(page, "agent-platform", "Agent Platform");
    expect(await overflow()).toBeLessThanOrEqual(0);
    const first = page.getByRole("region", { name: "History" });
    const options = first.getByRole("grid").getByRole("gridcell");
    await expect(options).toHaveCount(30);
    // Captions: the first cell's UTC date on the left, "Today" on the right.
    const firstLabel = (await options.first().getAttribute("aria-label")) ?? "";
    expect(firstLabel).toContain(" (UTC): ");
    const firstDate = firstLabel.slice(0, firstLabel.indexOf(" (UTC)"));
    await expect(first.getByText(firstDate, { exact: true })).toBeVisible();
    await expect(first.getByText("Today", { exact: true })).toBeVisible();
    await expect(first.getByText(/^30 days: .+, \d+ days? without data$/)).toBeAttached();
    const cell = await first.getByRole("grid").getByRole("gridcell").first().boundingBox();
    expect(cell?.width).toBeGreaterThanOrEqual(6);
  });

  test("the products table reflows at 320 px and under WCAG 1.4.12 text spacing", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 320, height: 800 });
    await ready(page);
    const clipped = () =>
      page.evaluate(
        () =>
          [...document.querySelectorAll('section[aria-label="Products"] tbody td')].filter(
            (td) => td.scrollWidth > td.clientWidth,
          ).length,
      );
    expect(await clipped()).toBe(0);
    await page.addStyleTag({
      content:
        "* { line-height: 1.5 !important; letter-spacing: 0.12em !important; word-spacing: 0.16em !important; } p { margin-bottom: 2em !important; }",
    });
    expect(await clipped()).toBe(0);
  });
});
