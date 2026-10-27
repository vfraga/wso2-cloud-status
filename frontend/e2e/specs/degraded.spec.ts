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

import { expect, test, type Locator, type Page } from "@playwright/test";
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

/** API Platform's cell for its `n`th place in the home page's table (0 US, 1 EU). */
const apiCell = (page: Page, n: number) =>
  productRows(page)
    .filter({ has: page.getByRole("link", { name: "API Platform", exact: true }) })
    .getByRole("cell")
    .nth(n);

test.describe("outage, degraded and maintenance components in one place, and an active incident", () => {
  test("banner, and the affected place with its parts in the table", async ({ page }) => {
    await ready(page);
    // One region of one product out: a partial outage naming it, not WSO2 Cloud down.
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(
      "Partial outage: API Platform",
    );
    // The banner names the affected product and regions, grouped by status.
    const banner = page.getByRole("region", { name: "Overall status" });
    await expect(banner).toContainText("Service outage: API Platform (EU data plane).");
    await expect(banner).toContainText("Under maintenance: API Platform (EU control plane).");
    await expect(banner).toContainText(ALL_BUT_ONE_OPERATIONAL);
    const [us, eu] = [apiCell(page, 0), apiCell(page, 1)];
    await expect(us).toContainText("Operational");
    // EU says how much of it is out; each part that is not operational shows its icon and name.
    await expect(eu.getByText("Partial outage", { exact: true })).toBeVisible();
    await expect(eu.getByText("Data plane", { exact: true })).toBeVisible();
    await expect(eu.getByText("Control plane", { exact: true })).toBeVisible();
    await expect(eu.locator("svg")).toHaveCount(3);
    for (const name of PRODUCT_NAMES.filter((n) => n !== "API Platform")) {
      const row = productRows(page).filter({ has: page.getByRole("link", { name, exact: true }) });
      await expect(
        row.getByRole("cell").filter({ hasText: /outage|Degraded|maintenance/ }),
      ).toHaveCount(0);
    }
    await page.screenshot({
      path: shotPath("e2e-degraded"),
      fullPage: true,
      animations: "disabled",
    });
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
    await expect(active.getByRole("link")).toHaveCount(1);
    await expect(active).toContainText("Investigating");
    await expect(active).toContainText(/Ongoing for 1h/);
    await expect(active.locator("time").first()).toHaveAttribute("title", /UTC$/);
    const before = await page.getByRole("region", { name: "Active incidents" }).boundingBox();
    const products = await page.getByRole("region", { name: "Products" }).boundingBox();
    expect(before!.y).toBeLessThan(products!.y);
  });

  test("the product page lists the resolved outage, and the ongoing incident above it", async ({
    page,
  }) => {
    await readyProduct(page, "api-platform", "API Platform");
    const recent = page.getByRole("region", { name: "Recent incidents" });
    await expect(recent.getByText("Console sign-in failures").first()).toBeVisible();
    await expect(recent.getByText(/Lasted 2h/).first()).toBeVisible();
    // The open incident is listed once, under Active incidents.
    await expect(recent.getByText("Elevated latency for API proxy invocation")).toHaveCount(0);
    await expect(recent.getByText("No incidents reported.", { exact: true })).toHaveCount(0);
  });

  test("aligns the incident meta row, and a place's parts under its status", async ({ page }) => {
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

    // In the table, a part's name lines up with the status text above it, past the icon.
    const eu = apiCell(page, 1);
    const textStart = (locator: Locator) =>
      locator.evaluate((el) => {
        const range = document.createRange();
        range.selectNodeContents(el);
        return range.getBoundingClientRect().left;
      });
    const cellStatus = await textStart(eu.getByText("Partial outage", { exact: true }));
    const partName = await textStart(eu.getByText("Data plane", { exact: true }));
    expect(Math.abs(partName - cellStatus)).toBeLessThanOrEqual(1);
  });

  test("a tapped day near the bottom of the screen opens below its strip, in view", async ({
    browser,
  }) => {
    const context = await browser.newContext({
      viewport: { width: 360, height: 800 },
      hasTouch: true,
    });
    const page = await context.newPage();
    await readyProduct(page, "api-platform", "API Platform");
    const strip = page.getByRole("region", { name: "History" }).getByRole("grid");
    // The strip's bottom edge about 70 px above the bottom of the screen.
    await strip.evaluate((el) => {
      window.scrollBy(0, el.getBoundingClientRect().bottom - (window.innerHeight - 70));
    });
    await strip.getByRole("gridcell").last().tap();
    const popper = page.locator(".MuiPopper-root");
    await expect(popper).toHaveAttribute("data-popper-placement", "bottom");
    // Scrolled into view, and clear of the strip.
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

  test("long words from the upstream wrap at 320 px on every page", async ({ browser }) => {
    // CSM operators write titles, messages and names; one may hold a URL. Each gets one here.
    const url = `https://status.example.com/incidents/${"x".repeat(80)}`;
    const context = await browser.newContext({ viewport: { width: 320, height: 800 } });
    await context.route("**/api/v1/**", async (route) => {
      const response = await route.fetch();
      if (response.status() !== 200) return route.fulfill({ response });
      const body = JSON.stringify(await response.json(), function (key, value: unknown) {
        const upstream =
          key === "title" ||
          key === "message" ||
          key === "description" ||
          (key === "name" && ("components" in this || "uptime" in this) && !("id" in this));
        return upstream && typeof value === "string" ? `${value} ${url}` : value;
      });
      return route.fulfill({ response, body });
    });
    const page = await context.newPage();
    const overflow = () =>
      page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      );
    await ready(page);
    await expect(page.getByRole("region", { name: "Active incidents" })).toContainText(url);
    expect(await overflow()).toBeLessThanOrEqual(0);
    await readyProduct(page, "api-platform", "API Platform");
    const closed = page.locator('button[aria-expanded="false"][aria-controls]');
    while ((await closed.count()) > 0) await closed.first().click();
    await expect(page.getByText(`API Proxy Invocation ${url}`)).toBeVisible();
    expect(await overflow()).toBeLessThanOrEqual(0);
    await page.getByRole("link", { name: "Older incidents" }).click();
    await expect(page.getByText(`Console sign-in failures ${url}`).first()).toBeVisible();
    expect(await overflow()).toBeLessThanOrEqual(0);
    await context.close();
  });

  test("a product's older incidents open the incident history filtered to it", async ({ page }) => {
    await readyProduct(page, "api-platform", "API Platform");
    await page.getByRole("link", { name: "Older incidents" }).click();
    await expect(page).toHaveURL(/\/history\?product=api-platform$/);
    await expect(page.getByRole("heading", { level: 1, name: "Incident history" })).toBeFocused();
    await expect(page).toHaveTitle("Incident history - WSO2 Cloud Status");
    await expect(page.getByRole("combobox", { name: "Product" })).toHaveValue("api-platform");
    await expect(page.getByText("Console sign-in failures").first()).toBeVisible();
    await page.getByRole("combobox", { name: "Product" }).selectOption("");
    await expect(page).toHaveURL(/\/history$/);
    await expectNoSeriousViolations(page);
    await page.getByRole("link", { name: "All products" }).click();
    await expect(page.getByRole("link", { name: "Incident history" })).toHaveAttribute(
      "href",
      "/history",
    );
  });

  test("the product page names the affected regions under the headline", async ({ page }) => {
    await readyProduct(page, "api-platform", "API Platform");
    const banner = page.getByRole("region", { name: "Overall status" });
    await expect(banner.getByRole("heading", { level: 1 })).toHaveAccessibleName(
      "API Platform (Bijira): Partial outage",
    );
    await expect(banner).toContainText("Service outage: EU data plane.");
    await expect(banner).toContainText("Under maintenance: EU control plane.");
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

  test("the strip counts the incidents the page lists, each once", async ({ page }) => {
    await readyProduct(page, "api-platform", "API Platform");
    const toggle = page
      .getByRole("region", { name: "History" })
      .getByRole("button", { name: / for API Platform$/ });
    // "2 incidents and 1 maintenance window": every record listed once.
    const counted = ((await toggle.innerText()).match(/\d+/g) ?? [])
      .map(Number)
      .reduce((a, b) => a + b, 0);
    // Ongoing incidents are listed under Active incidents, the others under Recent incidents.
    const active = page.getByRole("region", { name: "Active incidents" });
    const recent = page.getByRole("region", { name: "Recent incidents" });
    const listed =
      (await active.getByRole("heading", { level: 3 }).count()) +
      (await recent.getByRole("heading", { level: 4 }).count());
    expect(counted).toBeGreaterThan(0);
    expect(listed).toBe(counted);
  });

  test("history days with incidents are captioned and listed by a control", async ({ page }) => {
    await readyProduct(page, "api-platform", "API Platform");
    const api = page.getByRole("region", { name: "History" });
    const toggle = api.getByRole("button", {
      name: /^\d+ (incidents?|maintenance).* for API Platform$/,
    });
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-expanded", "true");
    const list = page.locator(`#${(await toggle.getAttribute("aria-controls")) ?? "missing"}`);
    await expect(list).toContainText(
      "Elevated latency for API proxy invocation in the EU data plane",
    );
    // Problem days stand out by height as well as colour: a problem bar fills its cell, a quiet one
    // stands at 60%, and every bar is rounded at the top as well as the bottom.
    const strip = api.getByRole("grid");
    const marked = strip.getByRole("gridcell", { name: /Incidents:/ }).first();
    const quiet = strip.getByRole("gridcell", { name: /: No incidents$/ }).first();
    const bar = (l: Locator) =>
      l.evaluate((el) => {
        const cs = getComputedStyle(el, "::before");
        return {
          share: parseFloat(cs.height) / el.getBoundingClientRect().height,
          top: cs.borderTopLeftRadius,
        };
      });
    const [q, m] = [await bar(quiet), await bar(marked)];
    expect(q.share).toBeCloseTo(0.6, 2);
    expect(m.share).toBeCloseTo(1, 2);
    expect(q.top).not.toBe("0px");
    expect(m.top).not.toBe("0px");
    await api.screenshot({ path: shotPath("e2e-degraded-days"), animations: "disabled" });
  });

  test("axe finds no serious or critical issues at 360 px, home and product page", async ({
    browser,
  }) => {
    await expectNoSeriousViolationsOnPhone(browser, ready);
    await expectNoSeriousViolationsOnPhone(browser, async (page) => {
      await readyProduct(page, "api-platform", "API Platform");
      await page
        .getByRole("button", { name: /^\d+ (incidents?|maintenance).* for API Platform$/ })
        .click();
    });
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
