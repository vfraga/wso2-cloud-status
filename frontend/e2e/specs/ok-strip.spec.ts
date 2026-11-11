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
import { readyProduct, RECENT_INCIDENT } from "../helpers";

/** Opens a product's page and returns its history strip. */
async function stripOf(page: Page, id: string, name: string) {
  await readyProduct(page, id, name);
  return page.getByRole("region", { name: "History" }).getByRole("grid");
}

test.describe("all operational", () => {
  test("history strip is one tab stop and the tooltip follows keyboard focus", async ({ page }) => {
    const strip = await stripOf(page, "agent-platform", "Agent Platform");
    await expect(strip.getByRole("gridcell")).toHaveCount(90);
    await page.getByRole("link", { name: "All products" }).focus();
    await page.keyboard.press("Tab");
    const today = strip.getByRole("gridcell").last();
    await expect(today).toBeFocused();
    await expect(page.locator(".MuiPopper-root")).toContainText("No incidents");
    await expect(page.locator(".MuiPopper-root")).toContainText("(UTC)");
    await expect(strip).toHaveAccessibleName("90-day history for Agent Platform, UTC days");
    await page.keyboard.press("ArrowLeft");
    await expect(strip.getByRole("gridcell").nth(88)).toBeFocused();
    await expect(page.locator(".MuiPopper-root")).toBeVisible();
    await page.keyboard.press("Tab");
    await expect(strip.getByRole("gridcell").nth(88)).not.toBeFocused();
    await expect(page.locator(".MuiPopper-root")).toHaveCount(0);
    await expect(page.getByText(/^90 days: .+, \d+ days? without data$/)).toBeAttached();
  });

  test("tooltip names the incidents of a day that had one", async ({ page }) => {
    const strip = await stripOf(page, "identity-platform", "Identity Platform");
    const marked = strip.getByRole("gridcell", { name: new RegExp(RECENT_INCIDENT) }).first();
    await marked.hover();
    await expect(page.locator(".MuiPopper-root")).toContainText("Service outage");
    await expect(page.locator(".MuiPopper-root")).toContainText(RECENT_INCIDENT);
  });

  test("shows 60 days at 700 px and 90 days at 900 px", async ({ page }) => {
    await page.setViewportSize({ width: 700, height: 800 });
    const options = (await stripOf(page, "agent-platform", "Agent Platform")).getByRole("gridcell");
    await expect(options).toHaveCount(60);
    await page.setViewportSize({ width: 900, height: 800 });
    await expect(options).toHaveCount(90);
    await page.setViewportSize({ width: 360, height: 800 });
    await expect(options).toHaveCount(30);
  });

  test("the history tooltip stays open while the pointer moves onto it", async ({ page }) => {
    const strip = await stripOf(page, "agent-platform", "Agent Platform");
    const today = strip.getByRole("gridcell").last();
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
    }).toPass({ timeout: 2_000 });
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
    const cell = (await stripOf(page, "api-platform", "API Platform"))
      .getByRole("gridcell")
      .nth(-3);
    await cell.hover();
    const tooltip = page.locator(".MuiPopper-root");
    await expect(tooltip).toBeVisible();
    expect(await page.evaluate(() => document.activeElement?.tagName)).toBe("BODY");
    await page.keyboard.press("Escape");
    await expect(tooltip).toHaveCount(0);
  });

  test("on a phone the tooltip opens below the strip, leaving the strip in view", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 360, height: 800 });
    const strip = await stripOf(page, "api-platform", "API Platform");
    // With room below, as for a strip a reader is looking at.
    await strip.evaluate((el) => {
      el.scrollIntoView({ block: "start" });
    });
    await strip.getByRole("gridcell").last().hover();
    const box = await strip.boundingBox();
    // Polled: the popper is placed a frame after it opens.
    await expect(async () => {
      const tooltip = await page.locator(".MuiPopper-root").boundingBox();
      expect((box?.y ?? Infinity) + (box?.height ?? 0)).toBeLessThanOrEqual(tooltip?.y ?? 0);
    }).toPass({ timeout: 2_000 });
  });

  test("the strip stays visible in forced colors, problem days apart from quiet ones", async ({
    browser,
  }) => {
    const context = await browser.newContext({ forcedColors: "active" });
    const page = await context.newPage();
    const strip = await stripOf(page, "identity-platform", "Identity Platform");
    const paint = (name: RegExp) =>
      strip
        .getByRole("gridcell", { name })
        .first()
        .evaluate((el) => {
          // The day is drawn by the cell's ::before bar.
          const bar = getComputedStyle(el, "::before");
          return { image: bar.backgroundImage, height: bar.height };
        });
    const problem = await paint(new RegExp(RECENT_INCIDENT));
    const quiet = await paint(/: No incidents$/);
    // Both drawn in system colours, a problem day in a different one, and taller.
    expect(problem.image).not.toBe("none");
    expect(quiet.image).not.toBe("none");
    expect(problem.image).not.toBe(quiet.image);
    expect(problem.height).not.toBe(quiet.height);
    await context.close();
  });

  test("the strip captions wrap under WCAG 1.4.12 text spacing at 320 px", async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 800 });
    await readyProduct(page, "api-platform", "API Platform");
    await page.addStyleTag({
      content:
        "* { line-height: 1.5 !important; letter-spacing: 0.12em !important; word-spacing: 0.16em !important; } p { margin-bottom: 2em !important; }",
    });
    const overflow = await page.evaluate(() => {
      const captions = [...document.querySelectorAll('[role="grid"]')].map((strip) => {
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
        [...document.querySelectorAll('[role="grid"]')].filter((strip) => {
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

  test("a legend says what the bars mean, and that days are UTC days", async ({ page }) => {
    await readyProduct(page, "api-platform", "API Platform");
    const legend = page.getByText("Each bar is one UTC day.").locator("..");
    const names = [
      "Service outage",
      "Degraded performance",
      "Maintenance",
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
      // Each swatch is centred on its label's line, and all are one size, as painted.
      const mark = label.locator("xpath=preceding-sibling::*[1]");
      const swatch = await mark.boundingBox();
      expect(Math.abs(middle(swatch) - middle(text))).toBeLessThanOrEqual(1);
      const painted = await mark.evaluate((el) => getComputedStyle(el, "::before").height);
      swatches.add(`${String(swatch?.width)}x${String(swatch?.height)}, painted ${painted}`);
    }
    expect(swatches.size).toBe(1);
    // The intro's text and each line of entries are centred under the strip.
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
    await legend.getByText("Maintenance", { exact: true }).hover();
    await expect(page.getByRole("tooltip")).toHaveText(
      "Planned maintenance that day, and no outage or degraded performance.",
    );
    // The footer speaks for every page; only a product page has bars.
    await expect(page.locator("footer")).not.toContainText("History bars");
  });

  test("on a phone a tapped legend description stays open until the reader taps elsewhere", async ({
    browser,
  }) => {
    const phone = await browser.newContext({
      viewport: { width: 360, height: 800 },
      hasTouch: true,
      isMobile: true,
    });
    const page = await phone.newPage();
    const pause = (ms: number) =>
      page.evaluate(
        (delay) =>
          new Promise((resolve) => {
            setTimeout(resolve, delay);
          }),
        ms,
      );
    await readyProduct(page, "api-platform", "API Platform");
    const entry = page
      .getByText("Each bar is one UTC day.")
      .locator("..")
      .getByText("Maintenance", { exact: true });
    await entry.scrollIntoViewIfNeeded();
    const box = await entry.boundingBox();
    const point = { x: (box?.x ?? 0) + 5, y: (box?.y ?? 0) + 5 };
    // A finger rests for a moment; Playwright's tap lifts in the same instant.
    const cdp = await phone.newCDPSession(page);
    await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [point] });
    await pause(200);
    await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    const tip = page.getByRole("tooltip");
    await expect(tip).toHaveText(
      "Planned maintenance that day, and no outage or degraded performance.",
    );
    // Time to read it: the tooltip's own touch timer closed it 1.5 s after the finger lifted.
    await pause(4_000);
    await expect(tip).toBeVisible();
    await page.getByRole("heading", { name: "Recent incidents" }).tap();
    await expect(tip).toHaveCount(0);
    await phone.close();
  });
});
