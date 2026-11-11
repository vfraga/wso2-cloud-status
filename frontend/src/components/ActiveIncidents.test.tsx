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

import { screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { incident, product } from "../test/factories";
import { wrap } from "../test/render";
import { ThemeRoot } from "../theme/ThemeRoot";
import { ActiveIncidents } from "./ActiveIncidents";

describe("ActiveIncidents", () => {
  it("lists active incidents or nothing", () => {
    const products = new Map([["api-platform", product()]]);
    const { container, rerender } = wrap(<ActiveIncidents incidents={[]} products={products} />);
    expect(container).toBeEmptyDOMElement();
    rerender(
      <ThemeRoot>
        <ActiveIncidents
          incidents={[incident({ resolvedAt: null, productId: "unknown-product" })]}
          products={products}
        />
      </ThemeRoot>,
    );
    expect(screen.getByRole("heading", { name: "Active incidents" })).toBeInTheDocument();
    expect(screen.getByText("unknown-product")).toBeInTheDocument();
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
  });

  it("links an active incident to its product here, and nowhere else", () => {
    wrap(
      <ActiveIncidents
        incidents={[incident({ resolvedAt: null, state: "investigating" })]}
        products={new Map([["api-platform", product()]])}
      />,
    );
    expect(screen.getByRole("link", { name: "API Platform" })).toHaveAttribute(
      "href",
      "/products/api-platform",
    );
    expect(screen.getAllByRole("link")).toHaveLength(1);
    expect(screen.getByText("Degraded performance")).toBeInTheDocument();
  });

  it("says how many more active incidents a product has than are listed, linking its page", () => {
    const listed = Array.from({ length: 10 }, (_, i) =>
      incident({ id: `inc-${String(i)}`, resolvedAt: null }),
    );
    const withCount = (count: number) =>
      new Map([
        ["api-platform", product({ activeIncidentCount: count })],
        ["moesif", product({ id: "moesif", name: "Moesif", activeIncidentCount: 0 })],
      ]);
    const products = withCount(12);
    const { rerender } = wrap(<ActiveIncidents incidents={listed} products={products} />);
    expect(
      screen.getByRole("link", { name: "2 more active incidents for API Platform" }),
    ).toHaveAttribute("href", "/products/api-platform");
    expect(screen.queryByText(/for Moesif/)).not.toBeInTheDocument();
    rerender(
      <ThemeRoot>
        <ActiveIncidents incidents={listed} products={withCount(11)} />
      </ThemeRoot>,
    );
    expect(
      screen.getByRole("link", { name: "1 more active incident for API Platform" }),
    ).toHaveAttribute("href", "/products/api-platform");
    // Every active incident is listed: no line.
    rerender(
      <ThemeRoot>
        <ActiveIncidents incidents={listed} products={withCount(10)} />
      </ThemeRoot>,
    );
    expect(screen.queryByText(/more active incident/)).not.toBeInTheDocument();
    // A product's own page lists every one, so it adds no such line.
    rerender(
      <ThemeRoot>
        <ActiveIncidents incidents={listed} products={products} linked={false} />
      </ThemeRoot>,
    );
    expect(screen.queryByText(/more active incident/)).not.toBeInTheDocument();
  });
});
