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
import {
  collectConsoleErrors,
  expectNoSeriousViolations,
  expectNoSeriousViolationsOnPhone,
  PRODUCT_NAMES,
  PRODUCTS,
  productRows,
  ready,
  readyProduct,
  shotPath,
} from "../helpers";

/** The resolved outage the ok fixtures put 10 days back (e2e/fixtures/ok). */
const RECENT_INCIDENT = "Sign-in errors in the EU region";

/** The history strip of the product named `name`. */
const stripOf = (page: Page, name: string) =>
  productRows(page)
    .filter({ has: page.getByRole("heading", { level: 2, name }) })
    .getByRole("listbox");

test.describe("all operational", () => {
  test("renders every product, all collapsed, with no console errors", async ({ page }) => {
    const errors = collectConsoleErrors(page);
    await ready(page);
    // A background tab shows the status.
    await expect(page).toHaveTitle("WSO2 Cloud Status");
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("All systems operational");
    const rows = productRows(page);
    await expect(rows).toHaveCount(PRODUCTS);
    await expect(rows.locator("h2")).toHaveText(PRODUCT_NAMES);
    const toggles = rows.getByRole("button", { name: /regions?$/ });
    await expect(toggles).toHaveCount(PRODUCTS);
    for (const toggle of await toggles.all()) {
      await expect(toggle).toHaveAttribute("aria-expanded", "false");
    }
    await expect(page.getByText(/^Status checked /).first()).toBeVisible();
    await expect(page.getByRole("heading", { level: 2, name: "Past incidents" })).toBeVisible();
    await expect(page.getByText("No incidents reported.").first()).toBeVisible();
    expect(errors).toEqual([]);
    await page.screenshot({ path: shotPath("e2e-light"), fullPage: true, animations: "disabled" });
  });

  test("lets the user open a region list and links each product to its own page", async ({
    page,
  }) => {
    await ready(page);
    const first = productRows(page).first();
    await first.getByRole("button", { name: /^\d+ regions?$/ }).click();
    // A place opens into its parts, each with its 90-day uptime as the upstream reports it.
    await first.getByRole("button", { name: /^US/ }).click();
    await expect(first.getByText("Control plane", { exact: true })).toBeVisible();
    await expect(first.getByText(/^\d{1,3}(\.\d{1,3})?% \(90d\)$/).first()).toBeVisible();
    await expect(
      first.getByRole("link", { name: /View status page for Agent Platform/ }),
    ).toHaveAttribute("href", "https://status.cloud.wso2.com");
  });

  test("history strip is one tab stop and the tooltip follows keyboard focus", async ({ page }) => {
    await ready(page);
    const row = productRows(page).first();
    const strip = row.getByRole("listbox");
    await expect(strip.getByRole("option")).toHaveCount(90);
    await row.getByRole("link", { name: "Agent Platform", exact: true }).focus();
    await page.keyboard.press("Tab");
    const today = strip.getByRole("option").last();
    await expect(today).toBeFocused();
    await expect(page.locator(".MuiPopper-root")).toContainText("No incidents");
    await expect(page.locator(".MuiPopper-root")).toContainText("(UTC)");
    await expect(strip).toHaveAccessibleName("90-day history for Agent Platform, UTC days");
    await page.keyboard.press("ArrowLeft");
    await expect(strip.getByRole("option").nth(88)).toBeFocused();
    await expect(page.locator(".MuiPopper-root")).toBeVisible();
    await page.keyboard.press("Tab");
    await expect(strip.getByRole("option").nth(88)).not.toBeFocused();
    await expect(page.locator(".MuiPopper-root")).toHaveCount(0);
    await expect(
      row.getByText(/^90 days: \d+ days? with incidents, \d+ days? without data$/),
    ).toBeAttached();
  });

  test("tooltip names the incidents of a day that had one", async ({ page }) => {
    await ready(page);
    const strip = stripOf(page, "Identity Platform");
    const marked = strip.getByRole("option", { name: new RegExp(RECENT_INCIDENT) }).first();
    await marked.hover();
    await expect(page.locator(".MuiPopper-root")).toContainText("Service outage");
    await expect(page.locator(".MuiPopper-root")).toContainText(RECENT_INCIDENT);
  });

  test("dark mode toggle changes the scheme and survives a reload", async ({ page }) => {
    await ready(page);
    const html = page.locator("html");
    await page.getByRole("button", { name: "Switch to dark mode" }).click();
    await expect(html).toHaveAttribute("data-color-scheme", "dark");
    const bg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
    expect(bg).toBe("rgb(15, 23, 42)");
    await page.screenshot({ path: shotPath("e2e-dark"), fullPage: true, animations: "disabled" });
    await page.reload();
    await expect(html).toHaveAttribute("data-color-scheme", "dark");
    await page.getByRole("button", { name: "Switch to light mode" }).click();
    await expect(html).toHaveAttribute("data-color-scheme", "light");
  });

  test("follows the system colour scheme", async ({ browser }) => {
    const context = await browser.newContext({ colorScheme: "dark" });
    const page = await context.newPage();
    await ready(page);
    await expect(page.locator("html")).toHaveAttribute("data-color-scheme", "dark");
    await context.close();
  });

  test("has no horizontal scroll at 360 px and shows a 30-day strip", async ({ page }) => {
    await page.setViewportSize({ width: 360, height: 800 });
    await ready(page);
    const first = productRows(page).first();
    await first.getByRole("button", { name: /^\d+ regions?$/ }).click();
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(0);
    const options = first.getByRole("listbox").getByRole("option");
    await expect(options).toHaveCount(30);
    // Captions: the first cell's UTC date on the left, "Today" on the right.
    const firstLabel = (await options.first().getAttribute("aria-label")) ?? "";
    expect(firstLabel).toContain(" (UTC): ");
    const firstDate = firstLabel.slice(0, firstLabel.indexOf(" (UTC)"));
    await expect(first.getByText(firstDate, { exact: true })).toBeVisible();
    await expect(first.getByText("Today", { exact: true })).toBeVisible();
    await expect(first.getByText(/^30 days: \d+ days? with incidents/)).toBeAttached();
    const cell = await first.getByRole("listbox").getByRole("option").first().boundingBox();
    expect(cell?.width).toBeGreaterThanOrEqual(6);
    await page.screenshot({ path: shotPath("e2e-mobile"), fullPage: true, animations: "disabled" });
  });

  test("shows 60 days at 700 px and 90 days at 900 px", async ({ page }) => {
    await page.setViewportSize({ width: 700, height: 800 });
    await ready(page);
    const options = productRows(page).first().getByRole("listbox").getByRole("option");
    await expect(options).toHaveCount(60);
    await page.setViewportSize({ width: 900, height: 800 });
    await expect(options).toHaveCount(90);
    await page.setViewportSize({ width: 360, height: 800 });
    await expect(options).toHaveCount(30);
  });

  test("buttons show the same focus ring as links, without the grey ripple", async ({ page }) => {
    await ready(page);
    const toggle = page.getByRole("button", { name: "Switch to dark mode" });
    await page.getByRole("link", { name: "WSO2 Cloud Status, home" }).focus();
    await page.keyboard.press("Tab");
    await expect(toggle).toBeFocused();
    const ring = await toggle.evaluate((el) => {
      const style = getComputedStyle(el);
      return { style: style.outlineStyle, width: style.outlineWidth, color: style.outlineColor };
    });
    expect(ring).toEqual({ style: "solid", width: "2px", color: "rgb(10, 90, 168)" });
    await expect(toggle.locator(".MuiTouchRipple-ripplePulsate")).toBeHidden();
    const regions = productRows(page)
      .first()
      .getByRole("button", { name: /^\d+ regions?$/ });
    await regions.focus();
    await page.keyboard.press("Shift+Tab");
    await page.keyboard.press("Tab");
    await expect(regions).toBeFocused();
    expect(await regions.evaluate((el) => getComputedStyle(el).outlineStyle)).toBe("solid");
  });

  test("the history tooltip stays open while the pointer moves onto it", async ({ page }) => {
    await ready(page);
    const today = productRows(page).first().getByRole("listbox").getByRole("option").last();
    await today.hover();
    const tooltip = page.locator(".MuiPopper-root");
    await expect(tooltip).toBeVisible();
    const cell = await today.boundingBox();
    let tipTop = 0;
    // The tooltip opens below the strip: straight down from the cell, across the
    // gap. Polled: the popper is placed a frame after it opens.
    await expect(async () => {
      tipTop = (await tooltip.boundingBox())?.y ?? 0;
      expect(tipTop).toBeGreaterThan((cell?.y ?? Infinity) + (cell?.height ?? 0));
    }).toPass();
    const x = (cell?.x ?? 0) + (cell?.width ?? 0) / 2;
    await page.mouse.move(x, tipTop + 4, { steps: 5 });
    // Longer than the 120 ms close delay: the tooltip must still be there, not reopened.
    await page.evaluate(() => new Promise((done) => setTimeout(done, 300)));
    await expect(tooltip).toBeVisible();
    await page.mouse.move(5, 5);
    await expect(tooltip).toHaveCount(0);
  });

  test("Escape closes a tooltip opened by hover, with focus elsewhere (WCAG 1.4.13)", async ({
    page,
  }) => {
    await ready(page);
    const cell = productRows(page).nth(1).getByRole("listbox").getByRole("option").nth(-3);
    await cell.hover();
    const tooltip = page.locator(".MuiPopper-root");
    await expect(tooltip).toBeVisible();
    expect(await page.evaluate(() => document.activeElement?.tagName)).toBe("BODY");
    await page.keyboard.press("Escape");
    await expect(tooltip).toHaveCount(0);
  });

  test("on a phone the tooltip leaves the row's name and status visible", async ({ page }) => {
    await page.setViewportSize({ width: 360, height: 800 });
    await ready(page);
    const row = productRows(page).nth(1);
    // With room below, as for a row a reader is looking at.
    await row.evaluate((el) => {
      el.scrollIntoView({ block: "start" });
    });
    await row.getByRole("listbox").getByRole("option").last().hover();
    const name = await row.getByRole("heading", { level: 2 }).boundingBox();
    const status = await row.getByText("Operational", { exact: true }).first().boundingBox();
    // Polled: the popper is placed a frame after it opens.
    await expect(async () => {
      const tooltip = await page.locator(".MuiPopper-root").boundingBox();
      for (const box of [name, status]) {
        expect((box?.y ?? Infinity) + (box?.height ?? 0)).toBeLessThanOrEqual(tooltip?.y ?? 0);
      }
    }).toPass();
  });

  test("the strip stays visible in forced colors, problem days apart from quiet ones", async ({
    browser,
  }) => {
    const context = await browser.newContext({ forcedColors: "active" });
    const page = await context.newPage();
    await ready(page);
    const strip = stripOf(page, "Identity Platform");
    const paint = (name: RegExp) =>
      strip
        .getByRole("option", { name })
        .first()
        .evaluate((el) => {
          const cs = getComputedStyle(el);
          const card = getComputedStyle(el.closest("section") ?? document.body).backgroundColor;
          return { bg: cs.backgroundColor, image: cs.backgroundImage, card };
        });
    const problem = await paint(new RegExp(RECENT_INCIDENT));
    const quiet = await paint(/: No incidents$/);
    expect(problem.bg).not.toBe(problem.card);
    expect(quiet.image).not.toBe("none");
    expect(quiet.bg).not.toBe(problem.bg);
    await page.screenshot({ path: shotPath("e2e-forced-colors"), animations: "disabled" });
    await context.close();
  });

  test("the strip captions wrap under WCAG 1.4.12 text spacing at 320 px", async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 800 });
    await ready(page);
    await page.addStyleTag({
      content:
        "* { line-height: 1.5 !important; letter-spacing: 0.12em !important; word-spacing: 0.16em !important; } p { margin-bottom: 2em !important; }",
    });
    const overflow = await page.evaluate(() => {
      const captions = [...document.querySelectorAll('[role="listbox"]')].map((strip) => {
        const row = strip.parentElement?.querySelector(":scope > .MuiStack-root");
        return row ? row.scrollWidth - row.clientWidth : 0;
      });
      return {
        page: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        captions: Math.max(...captions),
      };
    });
    expect(overflow).toEqual({ page: 0, captions: 0 });
    // A wrapped end caption ("Today") stays at the right, under the end of the strip.
    const misplaced = await page.evaluate(
      () =>
        [...document.querySelectorAll('[role="listbox"]')].filter((strip) => {
          const end = strip.parentElement?.querySelector(":scope > .MuiStack-root > :last-child");
          const box = strip.getBoundingClientRect();
          return (
            end !== null &&
            end !== undefined &&
            Math.abs(end.getBoundingClientRect().right - box.right) > 2
          );
        }).length,
    );
    expect(misplaced).toBe(0);
  });

  test("a legend says what the bars mean, and the footer that days are UTC days", async ({
    page,
  }) => {
    await ready(page);
    const legend = page.getByText("Each bar is one UTC day.").locator("..");
    const names = [
      "Service outage",
      "Degraded performance",
      "Under maintenance",
      "No incidents",
      "No data: information for this day is unavailable",
    ];
    const intro = await page.getByText("Each bar is one UTC day.").boundingBox();
    const middle = (b: typeof intro): number => (b?.y ?? 0) + (b?.height ?? 0) / 2;
    const swatches = new Set<string>();
    for (const name of names) {
      const label = legend.getByText(name, { exact: true });
      await expect(label).toBeVisible();
      // The entries start on the line below the intro.
      const text = await label.boundingBox();
      expect(text?.y ?? 0).toBeGreaterThanOrEqual((intro?.y ?? 0) + (intro?.height ?? 0));
      // Each swatch is centred on its label's line, and all are one size.
      const swatch = await label.locator("xpath=preceding-sibling::*[1]").boundingBox();
      expect(Math.abs(middle(swatch) - middle(text))).toBeLessThanOrEqual(1);
      swatches.add(`${String(swatch?.width)}x${String(swatch?.height)}`);
    }
    expect(swatches.size).toBe(1);
    // The intro's text and each line of entries are centred under the strips.
    const offCentre = await legend.evaluate((el) => {
      const outer = el.getBoundingClientRect();
      const mid = outer.left + outer.width / 2;
      const range = document.createRange();
      range.selectNodeContents(el.firstElementChild!);
      const lines = new Map<number, { left: number; right: number }>([
        [-1, range.getBoundingClientRect()],
      ]);
      for (const entry of el.lastElementChild!.children) {
        const b = entry.getBoundingClientRect();
        const line = lines.get(Math.round(b.top)) ?? { left: b.left, right: b.right };
        lines.set(Math.round(b.top), {
          left: Math.min(line.left, b.left),
          right: Math.max(line.right, b.right),
        });
      }
      return Math.max(...[...lines.values()].map((l) => Math.abs((l.left + l.right) / 2 - mid)));
    });
    expect(offCentre).toBeLessThanOrEqual(1);
    // A colour says what it means on hover.
    await legend.getByText("Under maintenance", { exact: true }).hover();
    await expect(page.getByRole("tooltip")).toHaveText(
      "Planned maintenance that day, and no outage or degraded performance.",
    );
    await expect(page.locator("footer")).toContainText("History bars are UTC calendar days.");
  });

  test("the header logo and the icons are WSO2's, and the tab names the site", async ({ page }) => {
    await ready(page);
    await expect(page).toHaveTitle("WSO2 Cloud Status");
    // The logo at the brand's digital minimum on a wide screen, in pure black or white.
    const logo = page.getByRole("link", { name: "WSO2 Cloud Status, home" }).locator("svg");
    expect((await logo.boundingBox())?.height).toBeCloseTo(36, 0);
    expect(await logo.evaluate((el) => getComputedStyle(el).fill)).toMatch(
      /^rgb\((0, 0, 0|255, 255, 255)\)$/,
    );
    // Every icon the page links is that file, not the HTML shell.
    const icons = await page
      .locator('link[rel="icon"], link[rel="apple-touch-icon"]')
      .evaluateAll((links) => links.map((l) => l.getAttribute("href") ?? ""));
    expect(icons).toEqual(["/favicon.ico", "/icon.svg", "/apple-touch-icon.png"]);
    for (const href of icons) {
      const res = await page.request.get(href);
      expect(res.status()).toBe(200);
      expect(res.headers()["content-type"]).toMatch(/^image\//);
    }
  });

  test("links to other sites take the text colour, never a status colour", async ({ page }) => {
    await ready(page);
    const link = productRows(page)
      .first()
      .getByRole("link", { name: /View status page for Agent Platform/ });
    const [linkColour, textColour] = await Promise.all([
      link.evaluate((el) => getComputedStyle(el).color),
      page.locator("body").evaluate((el) => getComputedStyle(el).color),
    ]);
    expect(linkColour).toBe(textColour);
    expect(await link.evaluate((el) => getComputedStyle(el).textDecorationLine)).toBe("underline");
    expect(await link.evaluate((el) => getComputedStyle(el).textDecorationColor)).toBe(textColour);
  });

  test("axe finds no serious or critical issues at 360 px, home and product page", async ({
    browser,
  }) => {
    await expectNoSeriousViolationsOnPhone(browser, ready);
    await expectNoSeriousViolationsOnPhone(browser, (page) =>
      readyProduct(page, "api-platform", "API Platform"),
    );
  });

  for (const scheme of ["light", "dark"] as const) {
    test(`axe finds no serious or critical issues in ${scheme} mode`, async ({ browser }) => {
      const context = await browser.newContext({ colorScheme: scheme });
      const page = await context.newPage();
      await ready(page);
      await productRows(page)
        .nth(1)
        .getByRole("button", { name: /^\d+ regions?$/ })
        .click();
      await expectNoSeriousViolations(page);
      await context.close();
    });
  }

  test("product page lists regions, components and uptime from the real API", async ({ page }) => {
    await ready(page);
    await page.getByRole("link", { name: "API Platform" }).first().click();
    await expect(page).toHaveURL(/\/products\/api-platform$/);
    // The view change is announced: the h1 has focus and names the product; the tab has its own title.
    await expect(page.getByRole("heading", { level: 1 })).toBeFocused();
    await expect(page.getByRole("heading", { level: 1 })).toHaveAccessibleName(
      "API Platform: All systems operational",
    );
    await expect(page).toHaveTitle("API Platform - WSO2 Cloud Status");
    await expect(page.getByText("Uptime (outages only, updated daily)").first()).toBeVisible();
    await expect(
      page.getByRole("link", { name: "Open the API Platform status page" }),
    ).toHaveAttribute("href", "https://status.bijira.dev");
    await expect(page.getByRole("heading", { level: 3, name: "US" })).toBeVisible();
    await expect(
      page.getByRole("heading", { level: 4, name: "Control plane" }).first(),
    ).toBeVisible();
    await expect(page.getByText("12mo").first()).toBeVisible();
    await expectNoSeriousViolations(page);
    // The pointer stayed where the link was, over a legend entry: move it off for the picture.
    await page.mouse.move(0, 0);
    await page.screenshot({
      path: shotPath("e2e-product"),
      fullPage: true,
      animations: "disabled",
    });
    await page.getByRole("link", { name: "All products" }).click();
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("All systems operational");
    await expect(page.getByRole("heading", { level: 1 })).toBeFocused();
    await expect(page).toHaveTitle("WSO2 Cloud Status");
  });

  test("an unknown product shows a plain not-found message", async ({ page }) => {
    await page.goto("/products/does-not-exist");
    await expect(
      page.getByRole("heading", { name: "We could not find that product" }),
    ).toBeVisible();
  });

  test("an API down from the first load still links every product's own page", async ({ page }) => {
    await page.route("**/api/v1/**", (route) => route.abort());
    await page.goto("/");
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Status unavailable", {
      timeout: 20_000,
    });
    const products = page.getByRole("region", { name: "Products" });
    await expect(products.getByRole("link")).toHaveCount(PRODUCTS);
    await expect(products.getByRole("link", { name: "API Platform status page" })).toHaveAttribute(
      "href",
      "https://status.bijira.dev",
    );
    await expect(page.getByRole("status")).toContainText("We cannot reach the status service");
  });

  test("without JavaScript, or when the app's scripts fail, every product's own page is linked", async ({
    browser,
  }) => {
    const statusPages = (page: Page) => page.getByRole("link", { name: / status page$/ });
    const noScript = await browser.newContext({ javaScriptEnabled: false });
    const plain = await noScript.newPage();
    await plain.goto("/");
    // Playwright's switch does not render <noscript> as a browser with scripting
    // off does, so the fallback shows here after its 3 seconds, not at once.
    await expect(statusPages(plain)).toHaveCount(PRODUCTS, { timeout: 10_000 });
    await expect(plain.getByRole("link", { name: "Moesif status page" })).toHaveAttribute(
      "href",
      "https://status.moesif.com",
    );
    await noScript.close();

    const broken = await browser.newContext();
    const page = await broken.newPage();
    await page.route("**/assets/*.js", (route) => route.abort());
    await page.goto("/");
    // Hidden for the first 3 seconds, while the app would normally replace it.
    await expect(statusPages(page)).toHaveCount(PRODUCTS, { timeout: 10_000 });
    await expect(page.getByRole("link", { name: "API Platform status page" })).toBeVisible();
    await page.screenshot({ path: shotPath("e2e-bundle-failed"), animations: "disabled" });
    await broken.close();
  });

  test("a normal load never shows the built-in fallback", async ({ page }) => {
    await ready(page);
    await expect(page.getByText("If the current status does not appear")).toHaveCount(0);
  });

  test("an unreachable API keeps the last data and shows a calm notice", async ({ page }) => {
    await ready(page);
    await page.route("**/api/v1/**", (route) => route.abort());
    // A visible tab polls at once on visibilitychange.
    await page.evaluate(() => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await expect(page.getByRole("status")).toContainText(
      "Status data may be out of date. We could not refresh it just now",
      { timeout: 15_000 },
    );
    await expect(productRows(page)).toHaveCount(PRODUCTS);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("All systems operational");
  });
});
