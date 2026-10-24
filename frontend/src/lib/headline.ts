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

import type { ProductSummary, Status, Summary } from "../api/types";
import { componentFreshness } from "./freshness";
import { productRows, rowStatus } from "./regions";
import {
  BANNER_LABEL,
  COMPONENTS_UNAVAILABLE,
  PARTIAL_HEADLINE,
  STATUS_LABEL,
  capitalise,
  isProblem,
  listNames,
  othersOperational,
  regionsUnavailable,
  unavailableFor,
} from "./status";

/** One sentence of the line under the headline, with the status it names, if any. */
export interface DetailLine {
  status: Status | null;
  text: string;
}

/** What the banner says: the h1, its colour and icon, and an optional line under it. */
export interface Headline {
  status: Status;
  label: string;
  /** The line under the headline, as one paragraph. */
  detail?: string;
  /**
   * The same sentences when more than one names a status, so the banner can
   * put each on its own line with its icon: a list is easier to scan on a
   * phone than a paragraph that changes status mid-line.
   */
  lines?: DetailLine[];
}

/*
 * The status is the API's: statusd computes it once and fails closed, so it
 * is unknown when data is missing and no problem is known. The
 * page renders it and never computes its own. What the headline adds is
 * words: a problem keeps its status as the headline, and the line under it
 * names what is affected, grouped by status when there is more than one,
 * then what is missing.
 */

/** Up to this many unknown products are named in the headline. */
const MAX_NAMED = 3;

/** Problem statuses, worst first. */
const PROBLEMS: readonly Status[] = ["outage", "degraded", "maintenance"];

function withDetail(headline: Headline, lines: readonly DetailLine[]): Headline {
  if (lines.length === 0) return headline;
  const detail = lines.map((l) => l.text).join(" ");
  const named = lines.filter((l) => l.status !== null).length;
  return named > 1 ? { ...headline, detail, lines: [...lines] } : { ...headline, detail };
}

const line = (status: Status | null, text: string): DetailLine => ({ status, text });

/**
 * "1 of 2 regions unavailable", counting what the row lists (a location
 * whose parts are partly unknown counts as unknown unless one has a
 * problem), or a note on components when every region is known.
 */
export function missingDataText(product: ProductSummary): string {
  const rows = productRows(product);
  const unknown = rows.filter((r) => rowStatus(r) === "unknown").length;
  return unknown > 0 ? regionsUnavailable(unknown, rows.length) : COMPONENTS_UNAVAILABLE;
}

/** Names to list under each problem status, in the order they were added. */
type Affected = Map<Status, string[]>;

function add(affected: Affected, status: Status, name: string): void {
  affected.set(status, [...(affected.get(status) ?? []), name]);
}

/** The product's problem regions by status: "API Platform (EU data plane)". */
function addProduct(affected: Affected, product: ProductSummary): void {
  for (const status of PROBLEMS) {
    const regions = product.regions.filter((r) => r.status === status).map((r) => r.name);
    if (regions.length > 0) add(affected, status, `${product.name} (${listNames(regions)})`);
  }
  // A status no region shows comes from an incident: the product is named alone.
  if (isProblem(product.status) && !product.regions.some((r) => r.status === product.status)) {
    add(affected, product.status, product.name);
  }
}

/**
 * "Affected: A and B." when everything shares the headline's status, which
 * already names it. Otherwise grouped by status, worst first, so maintenance
 * never reads as an outage: "Service outage: A (EU). Under maintenance: B (US)."
 */
function affectedSentences(headline: Status, affected: Affected): DetailLine[] {
  const present = PROBLEMS.filter((s) => affected.has(s));
  if (present.length === 1 && present[0] === headline) {
    return [line(headline, `Affected: ${listNames(affected.get(headline) ?? [])}.`)];
  }
  return present.map((s) => line(s, `${STATUS_LABEL[s]}: ${listNames(affected.get(s) ?? [])}.`));
}

function summaryLabel(status: Status, unknown: readonly ProductSummary[]): Headline {
  if (status !== "unknown") return { status, label: BANNER_LABEL[status] };
  if (unknown.length === 0) return { status, label: PARTIAL_HEADLINE };
  const label =
    unknown.length > MAX_NAMED
      ? `Status unavailable for ${String(unknown.length)} products`
      : unavailableFor(unknown.map((p) => p.name));
  return { status, label };
}

/** The API's status, with the products and regions it is about. */
export function summaryHeadline(summary: Summary): Headline {
  const { status, products } = summary;
  const unknown = products.filter((p) => p.status === "unknown");
  if (status === "unknown" && unknown.length === products.length) {
    return { status, label: BANNER_LABEL.unknown };
  }
  const affected: Affected = new Map();
  for (const p of products) if (isProblem(p.status)) addProduct(affected, p);
  const partial = products.filter((p) => p.status !== "unknown" && !p.dataComplete);
  const fine = products.filter((p) => p.status === "operational" && p.dataComplete).length;
  const headline = summaryLabel(status, unknown);
  // Each unknown product is named once: in the headline, or with its last
  // check in the banner's notice (componentNotes), or else in this line.
  const inNotice = new Set(componentFreshness(products).late.map((p) => p.name));
  const named = status === "unknown" && unknown.length <= MAX_NAMED;
  const unnamed = named ? [] : unknown.filter((p) => !inNotice.has(p.name));

  const lines = [
    ...affectedSentences(status, affected),
    ...(unnamed.length > 0
      ? [line("unknown", `${unavailableFor(unnamed.map((p) => p.name))}.`)]
      : []),
    ...partial.map((p) => line("unknown", `${p.name}: ${missingDataText(p)}.`)),
    ...(fine > 0 && fine < products.length ? [line(null, othersOperational(fine))] : []),
  ];
  return withDetail(headline, lines);
}

/** The same rules for one product, on its own page, its regions grouped by status. */
export function productHeadline(product: ProductSummary): Headline {
  const { status, dataComplete } = product;
  if (status === "unknown") return { status, label: BANNER_LABEL.unknown };
  const affected: Affected = new Map();
  for (const s of PROBLEMS) {
    for (const r of product.regions) if (r.status === s) add(affected, s, r.name);
  }
  const lines = [
    ...(isProblem(status) ? affectedSentences(status, affected) : []),
    ...(dataComplete ? [] : [line("unknown", `${capitalise(missingDataText(product))}.`)]),
  ];
  const headline: Headline =
    isProblem(status) || dataComplete
      ? { status, label: BANNER_LABEL[status] }
      : { status: "unknown", label: PARTIAL_HEADLINE };
  return withDetail(headline, lines);
}
