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

import AxeBuilder from "@axe-core/playwright";
import { expect, type Browser, type Page } from "@playwright/test";
import { FALLBACK_PRODUCTS } from "../src/lib/fallbackProducts";
import { othersOperational } from "../src/lib/status";

/** How many products the page lists: the catalogue, which a unit test ties to config/statusd.yaml. */
export const PRODUCTS = FALLBACK_PRODUCTS.length;
export const PRODUCT_NAMES = FALLBACK_PRODUCTS.map((p) => p.name);

/** "The other 5 products are operational." when one product is not. */
export const ALL_BUT_ONE_OPERATIONAL = othersOperational(PRODUCTS - 1);

/** Fails on serious or critical axe violations in the page as currently rendered. */
export async function expectNoSeriousViolations(page: Page): Promise<void> {
  const results = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"])
    .analyze();
  const serious = results.violations.filter(
    (v) => v.impact === "serious" || v.impact === "critical",
  );
  expect(
    serious.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`),
  ).toEqual([]);
}

export function collectConsoleErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  page.on("pageerror", (error) => errors.push(String(error)));
  return errors;
}

export const shotPath = (name: string): string =>
  `${process.env.SHOT_DIR ?? "test-results/shots"}/${name}.png`;

/** The home page's table rows, one per product (the header row left out). */
export const productRows = (page: Page) =>
  page.locator('section[aria-label="Products"] tbody > tr');

export async function ready(page: Page): Promise<void> {
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1 })).not.toHaveText("Checking status");
  await expect(productRows(page).first()).toBeVisible();
}

/** Opens a product page and waits for its data: the h1 names the product and its status. */
export async function readyProduct(page: Page, id: string, name: string): Promise<void> {
  await page.goto(`/products/${id}`);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(new RegExp(`^${name}: `));
  await expect(page.getByRole("heading", { level: 1 })).not.toHaveText(/Checking status/);
}

/**
 * The axe check at a 360 x 800 phone viewport in both schemes, where the WCAG
 * 2.2 target-size rule applies to links that wrap. `open` loads the page.
 */
export async function expectNoSeriousViolationsOnPhone(
  browser: Browser,
  open: (page: Page) => Promise<void>,
): Promise<void> {
  for (const colorScheme of ["light", "dark"] as const) {
    const context = await browser.newContext({
      viewport: { width: 360, height: 800 },
      colorScheme,
    });
    const page = await context.newPage();
    await open(page);
    await expectNoSeriousViolations(page);
    await context.close();
  }
}
