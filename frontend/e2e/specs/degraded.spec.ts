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

import { expect, test, type Locator } from "@playwright/test";
import {
  ALL_BUT_ONE_OPERATIONAL,
  expectNoSeriousViolations,
  expectNoSeriousViolationsOnPhone,
  PRODUCT_NAMES,
  productRows,
  ready,
  readyProduct,
  shotPath,
} from "../helpers";

test.describe("one degraded component and an active incident", () => {
  test("banner, auto-expanded product and affected-region count", async ({ page }) => {
    await ready(page);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Degraded performance");
    // The banner names the affected product and region.
    await expect(page.getByRole("region", { name: "Overall status" })).toContainText(
      `Affected: API Platform (EU Data Plane). ${ALL_BUT_ONE_OPERATIONAL}`,
    );
    const rows = productRows(page);
    const api = rows.filter({ has: page.getByRole("heading", { level: 2, name: "API Platform" }) });
    await expect(api.getByRole("button", { name: /4 regions/ })).toHaveAttribute(
      "aria-expanded",
      "true",
    );
    await expect(api.getByText("1 of 4 regions affected")).toBeVisible();
    await expect(api.getByText("EU Data Plane")).toBeVisible();
    for (const name of PRODUCT_NAMES.filter((n) => n !== "API Platform")) {
      const row = rows.filter({ has: page.getByRole("heading", { level: 2, name }) });
      await expect(row.getByRole("button", { name: /regions?$/ })).toHaveAttribute(
        "aria-expanded",
        "false",
      );
    }
    await page.screenshot({
      path: shotPath("e2e-degraded"),
      fullPage: true,
      animations: "disabled",
    });
  });

  test("the user can collapse an auto-expanded product", async ({ page }) => {
    await ready(page);
    const api = productRows(page).filter({
      has: page.getByRole("heading", { level: 2, name: "API Platform" }),
    });
    const toggle = api.getByRole("button", { name: /4 regions/ });
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
    await expect(api.getByText("EU Data Plane")).toBeHidden();
  });

  test("the active incident is listed above the products, with UTC in the time title", async ({
    page,
  }) => {
    await ready(page);
    const active = page.getByRole("region", { name: "Active incidents" });
    await expect(active).toBeVisible();
    await expect(active.getByRole("heading", { level: 3 })).toHaveText(
      "Elevated latency for API proxy invocation in the EU data plane",
    );
    await expect(active.getByRole("link", { name: "API Platform", exact: true })).toHaveAttribute(
      "href",
      "/products/api-platform",
    );
    await expect(
      active.getByRole("link", { name: "Updates on the API Platform status page" }),
    ).toHaveAttribute("href", "https://status.bijira.dev");
    await expect(active).toContainText("Investigating");
    await expect(active).toContainText(/Ongoing for 1h/);
    await expect(active.locator("time").first()).toHaveAttribute("title", /UTC$/);
    const before = await page.getByRole("region", { name: "Active incidents" }).boundingBox();
    const products = await page.getByRole("region", { name: "Products" }).boundingBox();
    expect(before!.y).toBeLessThan(products!.y);
  });

  test("past incidents list the resolved outage, and today the ongoing incident", async ({
    page,
  }) => {
    await ready(page);
    const past = page.getByRole("region", { name: "Past incidents" });
    // Listed under each local day it covers: one, or two when it crossed midnight.
    await expect(past.getByText("Console sign-in failures").first()).toBeVisible();
    await expect(past.getByText(/Lasted 2h/).first()).toBeVisible();
    // Today never reads "No incidents reported." while an incident is open, even
    // one that started the day before.
    const today = past.getByRole("region").first();
    await expect(today).toContainText(
      "Elevated latency for API proxy invocation in the EU data plane",
    );
    await expect(today.getByText("No incidents reported.", { exact: true })).toHaveCount(0);
  });

  test("aligns the incident meta row, the toggle with the product name, and indents regions", async ({
    page,
  }) => {
    await ready(page);
    const active = page.getByRole("region", { name: "Active incidents" });
    const centre = async (locator: Locator): Promise<number> => {
      const box = await locator.boundingBox();
      return (box?.y ?? 0) + (box?.height ?? 0) / 2;
    };
    const product = await centre(active.getByText("API Platform", { exact: true }));
    const status = await centre(active.getByText("Degraded performance", { exact: true }));
    const state = await centre(active.getByText("Investigating", { exact: true }));
    expect(Math.abs(product - status)).toBeLessThanOrEqual(1);
    expect(Math.abs(state - status)).toBeLessThanOrEqual(1);

    const api = productRows(page).filter({
      has: page.getByRole("heading", { level: 2, name: "API Platform" }),
    });
    const name = await api.getByRole("link", { name: "API Platform", exact: true }).boundingBox();
    const toggle = await api.getByRole("button", { name: /4 regions/ }).boundingBox();
    const strip = await api.getByRole("listbox").boundingBox();
    expect(Math.abs((toggle?.x ?? 0) - (name?.x ?? 99))).toBeLessThanOrEqual(0.5);
    expect(Math.abs((strip?.x ?? 0) - (name?.x ?? 99))).toBeLessThanOrEqual(0.5);

    const region = api.getByRole("listitem").first();
    const regionName = await region.getByText("US Control Plane").boundingBox();
    expect((regionName?.x ?? 0) - (toggle?.x ?? 0)).toBeGreaterThanOrEqual(15.5);
    expect((regionName?.x ?? 0) - (toggle?.x ?? 0)).toBeLessThanOrEqual(16.5);
    const productStatus = await api.getByText("Degraded performance").first().boundingBox();
    const regionStatus = await api.getByText("Degraded performance").last().boundingBox();
    const right = (b: typeof productStatus): number => (b?.x ?? 0) + (b?.width ?? 0);
    expect(Math.abs(right(productStatus) - right(regionStatus))).toBeLessThanOrEqual(1);
  });

  test("a tapped day near the bottom of the screen opens below its strip, in view", async ({
    browser,
  }) => {
    const context = await browser.newContext({
      viewport: { width: 360, height: 800 },
      hasTouch: true,
    });
    const page = await context.newPage();
    await ready(page);
    const api = productRows(page).filter({
      has: page.getByRole("heading", { level: 2, name: "API Platform" }),
    });
    const strip = api.getByRole("listbox");
    // The strip's bottom edge about 70 px above the bottom of the screen.
    await strip.evaluate((el) => {
      window.scrollBy(0, el.getBoundingClientRect().bottom - (window.innerHeight - 70));
    });
    await strip.getByRole("option").last().tap();
    const popper = page.locator(".MuiPopper-root");
    await expect(popper).toHaveAttribute("data-popper-placement", "bottom");
    // Scrolled into view, and clear of the row's name and status above the strip.
    await expect(popper).toBeInViewport({ ratio: 1 });
    // Polled: the popper is placed a frame after it opens.
    await expect(async () => {
      const tip = await popper.boundingBox();
      const stripBox = await strip.boundingBox();
      expect(tip?.y).toBeGreaterThanOrEqual((stripBox?.y ?? Infinity) + (stripBox?.height ?? 0));
    }).toPass();
    await page.screenshot({
      path: shotPath("e2e-degraded-tooltip-bottom"),
      animations: "disabled",
    });
    await context.close();
  });

  test("renders at 360 px without horizontal scroll", async ({ browser }) => {
    const context = await browser.newContext({ viewport: { width: 360, height: 800 } });
    const page = await context.newPage();
    await ready(page);
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(0);
    await page.screenshot({
      path: shotPath("e2e-degraded-mobile"),
      fullPage: true,
      animations: "disabled",
    });
    await context.close();
  });

  test("the product page names the affected region under the headline", async ({ page }) => {
    await readyProduct(page, "api-platform", "API Platform");
    const banner = page.getByRole("region", { name: "Overall status" });
    await expect(banner.getByRole("heading", { level: 1 })).toHaveAccessibleName(
      "API Platform: Degraded performance",
    );
    await expect(banner).toContainText("Affected: EU Data Plane.");
    // The ongoing incident comes first, above the history and the regions.
    const active = page.getByRole("region", { name: "Active incidents" });
    await expect(active.getByRole("heading", { level: 3 })).toHaveText(
      "Elevated latency for API proxy invocation in the EU data plane",
    );
    const incidentBox = await active.boundingBox();
    const historyBox = await page.getByRole("region", { name: "History" }).boundingBox();
    const regionsBox = await page.getByRole("heading", { level: 2, name: "Regions" }).boundingBox();
    expect(incidentBox!.y).toBeLessThan(historyBox!.y);
    expect(incidentBox!.y).toBeLessThan(regionsBox!.y);
    await expect(
      page.getByRole("region", { name: "Recent incidents" }).getByText("Elevated latency"),
    ).toHaveCount(0);
  });

  test("history days with incidents are captioned and listed by a control", async ({ page }) => {
    await ready(page);
    const api = productRows(page).filter({
      has: page.getByRole("heading", { level: 2, name: "API Platform" }),
    });
    const toggle = api.getByRole("button", { name: /days? with incidents for API Platform$/ });
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-expanded", "true");
    const list = page.locator(`#${(await toggle.getAttribute("aria-controls")) ?? "missing"}`);
    await expect(list).toContainText(
      "Elevated latency for API proxy invocation in the EU data plane",
    );
    // Problem days stand out by height as well as colour.
    const strip = api.getByRole("listbox");
    const marked = strip.getByRole("option", { name: /Incidents:/ }).first();
    const quiet = strip.getByRole("option", { name: /: No incidents$/ }).first();
    const size = (l: Locator) => l.evaluate((el) => getComputedStyle(el).backgroundSize);
    expect(await size(quiet)).toBe("100% 60%");
    expect(await size(marked)).not.toBe("100% 60%");
    await api.screenshot({ path: shotPath("e2e-degraded-days"), animations: "disabled" });
  });

  test("axe finds no serious or critical issues at 360 px, home and product page", async ({
    browser,
  }) => {
    await expectNoSeriousViolationsOnPhone(browser, async (page) => {
      await ready(page);
      await productRows(page)
        .getByRole("button", { name: /days? with incidents for API Platform$/ })
        .click();
    });
    await expectNoSeriousViolationsOnPhone(browser, (page) =>
      readyProduct(page, "api-platform", "API Platform"),
    );
  });

  test("axe finds no serious or critical issues in both themes", async ({ browser }) => {
    for (const scheme of ["light", "dark"] as const) {
      const context = await browser.newContext({ colorScheme: scheme });
      const page = await context.newPage();
      await ready(page);
      await expectNoSeriousViolations(page);
      if (scheme === "dark")
        await page.screenshot({
          path: shotPath("e2e-degraded-dark"),
          fullPage: true,
          animations: "disabled",
        });
      await context.close();
    }
  });
});
