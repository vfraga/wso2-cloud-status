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
import { FALLBACK_PRODUCTS } from "../../src/lib/fallbackProducts";
import {
  expectNoSeriousViolations,
  expectNoSeriousViolationsOnPhone,
  PRODUCTS,
  productRows,
  ready,
  readyProduct,
  RECENT_INCIDENT,
} from "../helpers";

test.describe("all operational", () => {
  test("fetches only the theme's font files", async ({ page }) => {
    const fonts: string[] = [];
    page.on("request", (request) => {
      if (request.resourceType() === "font") fonts.push(new URL(request.url()).pathname);
    });
    await ready(page);
    await readyProduct(page, "api-platform", "API Platform");
    await page.evaluate(() => document.fonts.ready);
    expect(fonts.length).toBeGreaterThan(0);
    expect(fonts.filter((path) => !/^\/assets\/inter-[0-9a-f]{8}\.woff2$/.test(path))).toEqual([]);
  });

  test("preloads the file the page's Latin text is drawn with", async ({ page }) => {
    const html = await (await page.request.get("/")).text();
    const link = html.split('rel="preload" as="font"')[1] ?? "";
    const preloaded = /href="([^"]+)"/.exec(link)?.[1];
    expect(preloaded).toBeDefined();
    // Every other font file fails, so Latin text in the theme's font loads
    // only if the preloaded file is that font's Latin subset.
    await page.route("**/*.woff2", (route) =>
      new URL(route.request().url()).pathname === preloaded ? route.continue() : route.abort(),
    );
    await ready(page);
    const loaded = await page.evaluate(() =>
      document.fonts.load('16px "Inter Variable"', "A").then(
        (faces) => faces.map((face) => face.status),
        () => ["error"],
      ),
    );
    expect(loaded).toEqual(["loaded"]);
  });

  test("dark mode toggle changes the scheme and survives a reload", async ({ page }) => {
    await ready(page);
    const html = page.locator("html");
    await page.getByRole("button", { name: "Switch to dark mode" }).click();
    await expect(html).toHaveAttribute("data-color-scheme", "dark");
    const bg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
    expect(bg).toBe("rgb(15, 23, 42)");
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
    await readyProduct(page, "api-platform", "API Platform");
    const regions = page.locator("button[aria-expanded]").first();
    await regions.focus();
    await page.keyboard.press("Shift+Tab");
    await page.keyboard.press("Tab");
    await expect(regions).toBeFocused();
    expect(await regions.evaluate((el) => getComputedStyle(el).outlineStyle)).toBe("solid");
  });

  test("a component the source sends no figures for shows a muted dash, read as not published", async ({
    page,
  }) => {
    await readyProduct(page, "agent-platform", "Agent Platform");
    const closed = page.locator('section[aria-labelledby="regions"] button[aria-expanded="false"]');
    while ((await closed.count()) > 0) await closed.first().click();
    const figures = page.getByRole("group", { name: "Uptime for Test Agent" });
    // Its components publish 30 and 90 days: a dash in each, the region-only columns blank.
    await expect(figures.getByRole("definition")).toHaveText(["-not published", "-not published"]);
    await expect(figures.getByRole("term")).toHaveText(["30 days", "90 days"]);
    const dash = figures.getByText("-", { exact: true }).first();
    await expect(dash).toHaveAttribute("aria-hidden", "true");
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

  test("links to other sites take the colour of their text, never a status colour", async ({
    page,
  }) => {
    await readyProduct(page, "agent-platform", "Agent Platform");
    const footer = page.locator("footer");
    const link = footer.getByRole("link", { name: "Cookie policy" });
    const [linkColour, textColour] = await Promise.all([
      link.evaluate((el) => getComputedStyle(el).color),
      footer.evaluate((el) => getComputedStyle(el).color),
    ]);
    expect(linkColour).toBe(textColour);
    expect(await link.evaluate((el) => getComputedStyle(el).textDecorationLine)).toBe("underline");
    expect(await link.evaluate((el) => getComputedStyle(el).textDecorationColor)).toBe(textColour);
  });

  test("no link on any page leads to a status page of a product", async ({ page }) => {
    const hrefs: string[] = [];
    const collect = async () => {
      hrefs.push(
        ...(await page
          .locator("a[href]")
          .evaluateAll((links) => links.map((a) => (a as HTMLAnchorElement).href))),
      );
    };
    await ready(page);
    await collect();
    for (const { id, name } of FALLBACK_PRODUCTS) {
      await readyProduct(page, id, name);
      await collect();
    }
    await page.goto("/history");
    await expect(page.getByText(RECENT_INCIDENT).first()).toBeVisible();
    await collect();
    expect(hrefs.length).toBeGreaterThan(0);
    const statusPages = hrefs.filter((href) =>
      /(^|\.)status\.|statuspage/.test(new URL(href).hostname),
    );
    expect(statusPages).toEqual([]);
  });

  test("axe finds no serious or critical issues at 360 px, home and product page", async ({
    browser,
  }) => {
    await expectNoSeriousViolationsOnPhone(browser, ready);
    await expectNoSeriousViolationsOnPhone(browser, (page) =>
      readyProduct(page, "api-platform", "API Platform"),
    );
  });

  test("axe finds no serious or critical issues while the data loads", async ({ page }) => {
    // The API never answers within the test: the page stays in its loading state.
    await page.route("**/api/v1/**", () => new Promise(() => undefined));
    for (const path of ["/", "/products/api-platform"]) {
      await page.goto(path);
      await expect(page.getByRole("heading", { level: 1 })).toContainText("Checking status");
      await expectNoSeriousViolations(page);
    }
  });

  for (const scheme of ["light", "dark"] as const) {
    test(`axe finds no serious or critical issues in ${scheme} mode`, async ({ browser }) => {
      const context = await browser.newContext({ colorScheme: scheme });
      const page = await context.newPage();
      await ready(page);
      await expectNoSeriousViolations(page);
      await readyProduct(page, "api-platform", "API Platform");
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
      "API Platform (Bijira): All systems operational",
    );
    await expect(page).toHaveTitle("API Platform - WSO2 Cloud Status");
    await expect(page.getByText(/^Uptime counts outages only/)).toBeVisible();
    await expect(page.getByRole("link", { name: "Older incidents" })).toHaveAttribute(
      "href",
      "/history?product=api-platform",
    );
    await expect(page.getByRole("heading", { level: 3, name: "US" })).toBeVisible();
    await expect(
      page.getByRole("heading", { level: 4, name: "Control plane" }).first(),
    ).toBeVisible();
    await expect(page.getByText("12mo").first()).toBeVisible();
    // Each figure sits right under its window's code: the columns are shared by every row.
    const codeRight = await page
      .getByText("12mo", { exact: true })
      .first()
      .evaluate((el) => el.getBoundingClientRect().right);
    const figureRight = await page
      .getByRole("group", { name: "Uptime for US control plane" })
      .locator("dd")
      .last()
      .evaluate((el) => el.getBoundingClientRect().right);
    expect(Math.abs(figureRight - codeRight)).toBeLessThanOrEqual(1);
    await expectNoSeriousViolations(page);
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

  test("an API down from the first load says product status is unavailable", async ({ page }) => {
    await page.route("**/api/v1/**", (route) => route.abort());
    await page.goto("/");
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Status unavailable", {
      timeout: 20_000,
    });
    const products = page.getByRole("region", { name: "Products" });
    await expect(products).toContainText("Product status is not available right now.");
    await expect(products.getByRole("link")).toHaveCount(0);
    await expect(page.getByRole("status")).toContainText("We cannot reach the status service");
  });

  test("without JavaScript, or when the app's scripts fail, the page says what to do", async ({
    browser,
  }) => {
    const advice = (page: Page) => page.getByText(/^If the current status does not appear/);
    const noScript = await browser.newContext({ javaScriptEnabled: false });
    const plain = await noScript.newPage();
    await plain.goto("/");
    // Playwright's switch does not render <noscript> as a browser with scripting
    // off does, so the fallback shows here after its 3 seconds, not at once.
    await expect(advice(plain)).toBeVisible({ timeout: 10_000 });
    await expect(plain.getByRole("link")).toHaveCount(0);
    await noScript.close();

    const broken = await browser.newContext();
    const page = await broken.newPage();
    await page.route("**/assets/*.js", (route) => route.abort());
    await page.goto("/");
    // Hidden for the first 3 seconds, while the app would normally replace it.
    await expect(advice(page)).toBeVisible({ timeout: 10_000 });
    await broken.close();
  });

  for (const [path, width, height] of [
    ["/", 1700, 2000],
    ["/", 360, 800],
    ["/products/moesif", 1700, 2000],
    ["/products/moesif", 360, 800],
  ] as const) {
    test(`${path} does not shift as its data arrives (${String(width)} px)`, async ({ page }) => {
      await page.setViewportSize({ width, height });
      // Hold the API back, so the loading state is painted first, as over a real network.
      await page.route("**/api/v1/**", async (route) => {
        await new Promise((resolve) => setTimeout(resolve, 500));
        await route.continue();
      });
      await page.addInitScript(() => {
        const shifts: { value: number; nodes: string[] }[] = [];
        Object.assign(window, { shifts });
        const describe = (node: Node | null): string => {
          if (!(node instanceof Element)) return String(node?.nodeName);
          const label = node.getAttribute("aria-label") ?? node.className.split(" ").pop();
          return `${node.tagName.toLowerCase()} ${String(label)}`;
        };
        new PerformanceObserver((list) => {
          for (const entry of list.getEntries() as (PerformanceEntry & {
            value: number;
            hadRecentInput: boolean;
            sources: { node: Node | null }[];
          })[]) {
            if (!entry.hadRecentInput) {
              shifts.push({
                value: entry.value,
                nodes: entry.sources.map((s) => describe(s.node)),
              });
            }
          }
        }).observe({ type: "layout-shift", buffered: true });
      });
      await page.goto(path);
      await expect(page.getByRole("heading", { level: 1 })).not.toHaveText(/Checking status/);
      if (path === "/") await expect(productRows(page).first()).toBeVisible();
      else await expect(page.getByRole("heading", { name: "Recent incidents" })).toBeVisible();
      // The observer reports after the frame that shifted: let one more frame pass.
      const shifts = await page.evaluate(
        () =>
          new Promise<{ value: number; nodes: string[] }[]>((resolve) => {
            requestAnimationFrame(() => {
              setTimeout(() => {
                resolve(
                  (window as unknown as { shifts: { value: number; nodes: string[] }[] }).shifts,
                );
              }, 0);
            });
          }),
      );
      const total = shifts.reduce((sum, s) => sum + s.value, 0);
      // Core Web Vitals call a score under 0.1 good.
      expect(total, JSON.stringify(shifts, null, 1)).toBeLessThan(0.1);
    });
  }

  test("a tab shown later, and a visit that starts on a product page, fetch the status anew", async ({
    page,
  }) => {
    // Responses the network answered; one handed over from a browser cache is not counted.
    let summaries = 0;
    await page.route("**/api/v1/summary", async (route) => {
      summaries += 1;
      await route.continue();
    });
    await page.addInitScript(() => {
      let hidden = true;
      Object.defineProperty(document, "hidden", { configurable: true, get: () => hidden });
      Object.defineProperty(document, "visibilityState", {
        configurable: true,
        get: () => (hidden ? "hidden" : "visible"),
      });
      Object.assign(window, {
        show: () => {
          hidden = false;
          document.dispatchEvent(new Event("visibilitychange"));
        },
      });
    });
    await page.goto("/");
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Checking status");
    const beforeShown = summaries;
    await page.evaluate(() => {
      (window as unknown as { show: () => void }).show();
    });
    await expect(page.getByRole("heading", { level: 1 })).not.toHaveText("Checking status");
    expect(summaries).toBeGreaterThan(beforeShown);

    await page.goto("/products/moesif");
    await page.evaluate(() => {
      (window as unknown as { show: () => void }).show();
    });
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(/^Moesif: (?!Checking)/);
    const beforeHome = summaries;
    await page.getByRole("link", { name: "All products" }).click();
    await expect(productRows(page).first()).toBeVisible();
    expect(summaries).toBeGreaterThan(beforeHome);
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
