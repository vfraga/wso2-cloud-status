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
import { capitalise } from "./status";

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
