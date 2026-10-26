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

import type { Location, ProductSummary, RegionSummary, Status } from "../api/types";
import { STATUS_RANK, capitalise } from "./status";

/** One line of a product's region list: a location with its parts, or a region on its own. */
export type RegionRow<R extends RegionSummary = RegionSummary> =
  { kind: "location"; location: Location; regions: R[] } | { kind: "region"; region: R };

/**
 * The rows a product lists, in the API's order: each location with its
 * regions, then the regions without a location. A region whose location the
 * page could not read is listed on its own rather than hidden, and a
 * location without regions is not listed.
 */
export function regionRows<R extends RegionSummary>(
  locations: readonly Location[],
  regions: readonly R[],
): RegionRow<R>[] {
  const parts = new Map<string, R[]>(locations.map((l) => [l.id, []]));
  const alone: R[] = [];
  for (const r of regions) {
    const list = r.location === undefined ? undefined : parts.get(r.location);
    if (list) list.push(r);
    else alone.push(r);
  }
  return [
    ...locations.flatMap((location) => {
      const own = parts.get(location.id) ?? [];
      return own.length > 0 ? [{ kind: "location" as const, location, regions: own }] : [];
    }),
    ...alone.map((region) => ({ kind: "region" as const, region })),
  ];
}

/** A product's own rows (its summary regions). */
export function productRows(product: ProductSummary): RegionRow[] {
  return regionRows(product.locations, product.regions);
}

export function rowStatus(row: RegionRow): Status {
  return row.kind === "location" ? row.location.status : row.region.status;
}

function rowName(row: RegionRow): string {
  return row.kind === "location" ? row.location.name : row.region.name;
}

/** The places the products run in (US, EU), by name, in the order the API first lists them. */
export function placeNames(products: readonly ProductSummary[]): string[] {
  return [...new Set(products.flatMap((p) => productRows(p).map(rowName)))];
}

/** The place's own status first, then the others from the most severe. */
function rank(status: Status, place: Status): number {
  return status === place ? Number.MAX_SAFE_INTEGER : STATUS_RANK[status];
}

/** A part of a place, by its short name ("Data plane"), and its status. */
export interface PartStatus {
  name: string;
  status: Status;
}

/** A product's status in one place, and the parts of the place that are not operational. */
export interface PlaceStatus {
  status: Status;
  /** Listed only when the parts differ: the data plane alone when only it is degraded. */
  parts: PartStatus[];
}

/**
 * A product's status in the place named `name`, as statusd computed it;
 * undefined where the product does not run.
 */
export function placeStatus(product: ProductSummary, name: string): PlaceStatus | undefined {
  const row = productRows(product).find((r) => rowName(r) === name);
  if (row === undefined) return undefined;
  if (row.kind === "region") return { status: row.region.status, parts: [] };
  const { location, regions } = row;
  const differ = regions.some((r) => r.status !== location.status);
  // The parts that carry the place's status first, then the others by severity.
  const parts = differ
    ? regions
        .filter((r) => r.status !== "operational")
        .map((r) => ({ name: shortName(r, location), status: r.status }))
        .sort((a, b) => rank(b.status, location.status) - rank(a.status, location.status))
    : [];
  return { status: location.status, parts };
}

/**
 * A region's name under its location: "EU data plane" under EU reads "Data
 * plane". statusd requires the name to start with the location's.
 */
export function shortName(region: RegionSummary, location: Location): string {
  const prefix = `${location.name} `;
  return region.name.startsWith(prefix) && region.name.length > prefix.length
    ? capitalise(region.name.slice(prefix.length))
    : region.name;
}
