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

import { readdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { config as pageConfig } from "../config";
import { FALLBACK_PRODUCTS, PRODUCT_LEGAL, type FallbackProduct } from "./fallbackProducts";

/*
 * A YAML library is not worth a dependency for two keys in a file whose
 * layout is fixed: products are "  - id: ..." items under a top-level
 * "products:" key, with "name" at four spaces. Deeper keys are ignored. The
 * parser fails loudly when the layout changes, rather than passing on a
 * misread file.
 */
function productsFromConfig(text: string): FallbackProduct[] {
  const lines = text.split("\n");
  const start = lines.findIndex((l) => l === "products:");
  if (start < 0) throw new Error("no top-level products: key");
  const products: FallbackProduct[] = [];
  const unquote = (v: string): string => v.trim().replace(/^(["'])(.*)\1$/, "$2");
  for (const line of lines.slice(start + 1)) {
    if (/^\S/.test(line)) break;
    const id = /^ {2}- id: (.+)$/.exec(line)?.[1];
    if (id !== undefined) {
      products.push({ id: unquote(id), name: "" });
      continue;
    }
    const name = /^ {4}name: (.+)$/.exec(line)?.[1];
    const current = products.at(-1);
    if (name !== undefined && current) current.name = unquote(name);
  }
  return products;
}

describe("built-in product list", () => {
  // A path, not a URL object: jsdom replaces the global URL, which node:fs rejects.
  const here = dirname(fileURLToPath(import.meta.url));
  const config = readFileSync(resolve(here, "../../../config/statusd.yaml"), "utf8");

  it("match the products in config/statusd.yaml, in order", () => {
    const fromConfig = productsFromConfig(config);
    expect(fromConfig.length).toBeGreaterThan(0);
    for (const p of fromConfig) expect(p.name).not.toBe("");
    expect(FALLBACK_PRODUCTS).toEqual(fromConfig);
  });

  it("give every product, and only those, a privacy policy and terms of use", () => {
    expect(Object.keys(PRODUCT_LEGAL)).toEqual(FALLBACK_PRODUCTS.map((p) => p.id));
    for (const legal of Object.values(PRODUCT_LEGAL)) {
      expect(legal.privacy).toMatch(/^https:\/\//);
      expect(legal.terms).toMatch(/^https:\/\//);
    }
  });

  // The page holds two of statusd's settings as fixed numbers. Changing either in
  // the configuration needs a new frontend build; this keeps the shipped pair
  // equal.
  it("keep the page's limits equal to config/statusd.yaml", () => {
    const value = (key: string): string => {
      const found = new RegExp(`^ {2}${key}: (\\S+)$`, "m").exec(config)?.[1];
      if (found === undefined) throw new Error(`config/statusd.yaml has no ${key}`);
      return found;
    };
    const units: Record<string, number> = { s: 1_000, m: 60_000, h: 3_600_000 };
    const [, amount = "", unit = ""] = /^(\d+)([smh])$/.exec(value("stale_after")) ?? [];
    // The page calls data unavailable at the API's own stale_after.
    expect(Number(amount) * (units[unit] ?? Number.NaN)).toBe(pageConfig.staleAfterMs);
  });

  // statusd rejects a cache_control that holds a CDN copy for a whole poll of the
  // page; it holds the page's poll as browserPoll.
  it("keep the page's poll equal to the one statusd validates the cache against", () => {
    const go = readFileSync(
      resolve(here, "../../../backend/go/internal/config/validate.go"),
      "utf8",
    );
    const seconds = Number(/\tbrowserPoll += (\d+) \* time\.Second$/m.exec(go)?.[1]);
    expect(seconds * 1_000).toBe(pageConfig.summaryIntervalMs);
    expect(seconds * 1_000).toBe(pageConfig.productIntervalMs);
  });

  // The end-to-end specs take the catalogue from e2e/helpers.ts. A spec that
  // names every product, or counts them or the table's cells with a number,
  // is a second copy that adding a product breaks (adding one needs no test
  // change).
  it("stay the only copy the end-to-end specs read", () => {
    const specs = resolve(here, "../../e2e/specs");
    const count = new RegExp(`toHaveCount\\(${String(FALLBACK_PRODUCTS.length)}\\b`);
    for (const file of readdirSync(specs)) {
      const text = readFileSync(resolve(specs, file), "utf8");
      const named = FALLBACK_PRODUCTS.filter((p) => text.includes(`"${p.name}"`));
      expect(named.length, `${file} names every product`).toBeLessThan(FALLBACK_PRODUCTS.length);
      expect(text, `${file} counts the products with a number`).not.toMatch(count);
      expect(text, `${file} counts the table's cells with a number`).not.toMatch(
        /cells\.filter\(.*\)\)\.toHaveCount\(\d/,
      );
    }
  });

  it("parser reads product fields and skips a source's", () => {
    const text = [
      "backends: {}",
      "products:",
      "  - id: one",
      '    name: "One"',
      "    sources:",
      "      - backend: b",
      "        name: deeper",
      "  - id: two",
      "    name: Two",
      "other: x",
      "  - id: not-a-product",
    ].join("\n");
    expect(productsFromConfig(text)).toEqual([
      { id: "one", name: "One" },
      { id: "two", name: "Two" },
    ]);
    expect(() => productsFromConfig("server: {}")).toThrow(/products/);
  });
});
