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

import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import { locatedProduct, part, product } from "../test/factories";
import { wrap } from "../test/render";
import { StatusTable, StatusTableSkeleton } from "./StatusTable";

describe("StatusTable", () => {
  const eu = { id: "eu", name: "EU", status: "operational" as const };
  const us = { id: "us", name: "US", status: "operational" as const };
  const usOnly = product({
    id: "moesif",
    name: "Moesif",
    description: "Moesif analytics",
    regions: product().regions.slice(0, 1),
  });

  afterEach(() => {
    window.history.pushState(null, "", "/");
  });

  it("has a row per product and a column per place, each cell a status in words", () => {
    wrap(<StatusTable products={[locatedProduct({ description: "Bijira" }), usOnly]} />);
    const table = screen.getByRole("table", { name: "Current status of each product by region" });
    expect(
      within(table)
        .getAllByRole("columnheader")
        .map((h) => h.textContent),
    ).toEqual(["Product", "US", "EU"]);
    const rows = within(table).getAllByRole("row").slice(1);
    expect(rows.map((r) => within(r).getByRole("rowheader").textContent)).toEqual([
      "API PlatformBijira",
      "MoesifMoesif analytics",
    ]);
    expect(within(rows[0]!).getAllByText("Operational")).toHaveLength(2);
    // A place the product does not run in shows "-", and says so to a screen reader.
    expect(within(rows[1]!).getByText("No EU region")).toBeInTheDocument();
    expect(within(rows[1]!).getByRole("link", { name: "Moesif" })).toHaveAttribute(
      "href",
      "/products/moesif",
    );
  });

  it("says how much of a place is out, then names each part that is not operational", () => {
    const degraded = locatedProduct({
      locations: [us, { ...eu, status: "outage" }],
      regions: [
        part("US control plane"),
        part("US data plane"),
        part("EU control plane", "maintenance"),
        part("EU data plane", "outage"),
      ],
    });
    wrap(<StatusTable products={[degraded]} />);
    const cells = screen.getAllByRole("cell");
    expect(within(cells[1]!).getByText("Partial outage")).toBeInTheDocument();
    expect(within(cells[1]!).queryByText("Service outage")).toBeNull();
    // Each part shows its icon and name; a screen reader hears its status.
    for (const [name, spoken] of [
      ["Data plane", "Data plane: service outage"],
      ["Control plane", "Control plane: under maintenance"],
    ] as const) {
      expect(within(cells[1]!).getByText(name)).toHaveAttribute("aria-hidden", "true");
      expect(within(cells[1]!).getByText(spoken)).toHaveClass("cs-visually-hidden");
    }
    expect(within(cells[0]!).queryByText(/plane/)).not.toBeInTheDocument();
  });

  it("says major outage where every part of a place is out, and keeps a lone region's words", () => {
    const down = locatedProduct({
      locations: [us, { ...eu, status: "outage" }],
      regions: [
        part("US control plane"),
        part("US data plane"),
        part("EU control plane", "outage"),
        part("EU data plane", "outage"),
      ],
    });
    // A region that is a place itself is one part, not a roll-up.
    const lone = product({ regions: [{ ...product().regions[0]!, status: "outage" }] });
    wrap(<StatusTable products={[down, lone]} />);
    const rows = screen.getAllByRole("row").slice(1);
    const euCell = within(rows[0]!).getAllByRole("cell")[1]!;
    expect(within(euCell).getByText("Major outage")).toBeInTheDocument();
    expect(within(euCell).queryByText(/plane/)).toBeNull();
    expect(within(rows[1]!).getByText("Service outage")).toBeInTheDocument();
  });

  it("shows the status of a product without regions across the columns, never 'no region'", () => {
    const silent = product({ id: "agent", name: "Agent", status: "unknown", regions: [] });
    wrap(<StatusTable products={[locatedProduct(), silent]} />);
    const row = screen.getAllByRole("row").at(-1)!;
    expect(within(row).getByText("Status unavailable")).toBeInTheDocument();
    expect(within(row).queryByText(/region$/)).not.toBeInTheDocument();
    expect(within(row).getByRole("cell")).toHaveAttribute("colspan", "2");
  });

  it("says under the name when an incident that names no region puts the product above every place", () => {
    // statusd: product status outage from an active incident, every location operational.
    wrap(<StatusTable products={[locatedProduct({ status: "outage" }), usOnly]} />);
    const [first, second] = screen.getAllByRole("rowheader");
    expect(within(first!).getByText("Service outage, region not stated")).toBeInTheDocument();
    expect(within(second!).queryByText(/region not stated/)).toBeNull();
  });

  it("adds no line when a place already carries the product's status", () => {
    const placed = locatedProduct({
      status: "outage",
      locations: [us, { ...eu, status: "outage" }],
      regions: [
        part("US control plane"),
        part("US data plane"),
        part("EU control plane"),
        part("EU data plane", "outage"),
      ],
    });
    wrap(<StatusTable products={[placed]} />);
    expect(screen.queryByText(/region not stated/)).toBeNull();
  });

  it("opens the product from anywhere on its row", async () => {
    wrap(<StatusTable products={[locatedProduct()]} />);
    await userEvent.click(screen.getAllByText("Operational")[0]!);
    expect(window.location.pathname).toBe("/products/api-platform");
  });

  it("leaves this tab where it is when the name is opened in another", async () => {
    window.history.replaceState(null, "", "/");
    wrap(<StatusTable products={[locatedProduct()]} />);
    const user = userEvent.setup();
    for (const key of ["Meta", "Control", "Shift", "Alt"]) {
      await user.keyboard(`{${key}>}`);
      await user.click(screen.getByRole("link", { name: /API Platform/ }));
      await user.keyboard(`{/${key}}`);
      expect(window.location.pathname, key).toBe("/");
    }
  });

  it("holds the table's place while loading", () => {
    wrap(<StatusTableSkeleton />);
    expect(document.querySelector('[aria-busy="true"]')).toBeInTheDocument();
  });
});
