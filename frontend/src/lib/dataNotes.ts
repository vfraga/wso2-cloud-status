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

import type { Incident, ProductSummary } from "../api/types";
import {
  componentFreshness,
  incidentCoverage,
  type IncidentCoverage,
  type LateProduct,
} from "./freshness";
import {
  INCIDENTS_INCOMPLETE_LABEL,
  INCIDENTS_UNAVAILABLE_LABEL,
  UPTIME_INCOMPLETE_LABEL,
  UPTIME_UNAVAILABLE_LABEL,
  incidentInfoPartlyUnavailable,
  incidentInfoUnavailable,
  incidentsLastUpdated,
  incidentsNotUpdated,
  listNames,
  noStatusDataYet,
  statusDataLastChecked,
  uptimeLastUpdated,
} from "./status";
import { earliest, formatCheckAge, formatUtcTime } from "./time";

/*
 * Sentences that name what is late, from the body's checked_at and stale.
 * Times are absolute (UTC), so a live region that carries them does not
 * change, and so re-announce, every minute.
 */

/** A product to name in a sentence shared by every product with the same `key`. */
interface Named {
  key: string;
  name: string;
  text: (names: string) => string;
}

/** One sentence per group of products with the same wording and time, names joined. */
function grouped(items: readonly Named[]): string[] {
  const groups = new Map<string, { names: string[]; text: (names: string) => string }>();
  for (const { key, name, text } of items) {
    const group = groups.get(key) ?? { names: [], text };
    group.names.push(name);
    groups.set(key, group);
  }
  return [...groups.values()].map((g) => g.text(listNames(g.names)));
}

/** Late products grouped by wording and time: one sentence per group. */
export function componentNotes(late: readonly LateProduct[], now: Date): string[] {
  return grouped(
    late.map((p) => {
      const time = p.at === null ? null : formatUtcTime(p.at, now);
      return {
        key: `${String(p.partly)} ${time ?? ""}`,
        name: p.name,
        text:
          time === null
            ? (names: string) => noStatusDataYet(names, p.partly)
            : (names: string) => statusDataLastChecked(names, time, p.partly),
      };
    }),
  );
}

/** Some of the product's incidents are at hand: another of its sources answered. */
function someIncidentsKnown(product: ProductSummary, known: readonly Incident[]): boolean {
  return known.some((i) => i.productId === product.id);
}

/**
 * The banner's secondary line: incident feeds that are not current. One that
 * stopped after answering is named with its time; one that never answered
 * says the information is unavailable, or incomplete when another of the
 * product's sources answered (`known` are the incidents at hand). A product
 * whose status is unknown is already named as unavailable, so it is not
 * named again. Undefined when there is nothing to say.
 */
export function incidentFeedsLine(
  products: readonly ProductSummary[],
  known: readonly Incident[],
  now: Date,
): string | undefined {
  const items = products.flatMap((p): Named[] => {
    const coverage = incidentCoverage(p);
    if (coverage.state === "current" || p.status === "unknown") return [];
    if (coverage.state === "until") {
      const time = formatUtcTime(coverage.at, now);
      return [{ key: `until ${time}`, name: p.name, text: (n) => incidentsNotUpdated(n, time) }];
    }
    const partly = someIncidentsKnown(p, known);
    return [
      {
        key: `never ${String(partly)}`,
        name: p.name,
        text: partly ? incidentInfoPartlyUnavailable : incidentInfoUnavailable,
      },
    ];
  });
  const sentences = grouped(items);
  return sentences.length > 0 ? sentences.join(" ") : undefined;
}

/**
 * For an ongoing incident, when it was last known to be ongoing: the last
 * successful fetch of a feed that stopped, or `knownUntil`, when the page's
 * own data stopped (useKnownUntil), whichever is earlier. Null while both
 * are current.
 */
export function lastKnownAt(
  incident: Incident,
  product: ProductSummary | undefined,
  knownUntil: Date | null = null,
): Date | null {
  if (incident.resolvedAt !== null) return null;
  const coverage = product === undefined ? null : incidentCoverage(product);
  return earliest(coverage?.state === "until" ? coverage.at : null, knownUntil);
}

/** Per kind, whether some of a product's data of that kind is shown although one source never answered. */
export interface PartlyShown {
  incidents: boolean;
  uptime: boolean;
}

/**
 * The row's lines for stale incident and uptime feeds: "Incidents last
 * updated 2:05 PM UTC (12 min ago)", or "Incident information unavailable"
 * when the feed never answered ("incomplete" when other sources' data of
 * that kind is shown). Empty when both are current. `uptime` false leaves
 * out the uptime line, where no uptime is shown.
 */
export function staleFeedLines(
  product: ProductSummary,
  now: Date,
  partly: PartlyShown = { incidents: false, uptime: false },
  uptime = true,
): string[] {
  const { stale, checkedAt } = product.freshness;
  const line = (
    isStale: boolean,
    at: Date | null,
    never: string,
    updated: (time: string, ago: string) => string,
  ): string[] => {
    if (!isStale) return [];
    if (at === null) return [never];
    return [updated(formatUtcTime(at, now), formatCheckAge(now.getTime() - at.getTime(), true))];
  };
  return [
    ...line(
      stale.incidents,
      checkedAt.incidents,
      partly.incidents ? INCIDENTS_INCOMPLETE_LABEL : INCIDENTS_UNAVAILABLE_LABEL,
      incidentsLastUpdated,
    ),
    ...line(
      uptime && stale.uptime,
      checkedAt.uptime,
      partly.uptime ? UPTIME_INCOMPLETE_LABEL : UPTIME_UNAVAILABLE_LABEL,
      uptimeLastUpdated,
    ),
  ];
}

/** What a page's banner needs to say how current its data is. */
interface BannerFreshness {
  checkedAt: Date | null;
  notes: string[];
  someLate: boolean;
  lastSuccessAt: Date | null;
  failed: boolean;
  servedStale: boolean;
  skewMs: number;
  secondary?: string;
}

interface PolledFreshness {
  lastSuccessAt: Date | null;
  failed: boolean;
  staleOnArrival: boolean;
  skewMs: number;
}

/**
 * The banner's freshness inputs for the products a page shows (all of them on
 * the home page, one on its own page), from their checked_at and stale, and
 * the incidents at hand. No products, no age: the headline then has nothing
 * to date.
 */
export function bannerFreshness(
  state: PolledFreshness,
  products: readonly ProductSummary[] | null,
  known: readonly Incident[],
  now: Date,
): BannerFreshness {
  const body = componentFreshness(products ?? []);
  const secondary = products === null ? undefined : incidentFeedsLine(products, known, now);
  return {
    checkedAt: body.checkedAt,
    notes: componentNotes(body.late, now),
    someLate: body.late.length > 0,
    lastSuccessAt: state.lastSuccessAt,
    failed: state.failed,
    // generated_at ages only with the whole snapshot (a frozen service or an
    // old cached copy), so an old one means an old copy whatever the
    // products' own checks say.
    servedStale: state.staleOnArrival,
    skewMs: state.skewMs,
    ...(secondary === undefined ? {} : { secondary }),
  };
}

/** A product whose incident data is not complete, and how. */
export interface MissingIncidents {
  product: ProductSummary;
  coverage: Exclude<IncidentCoverage, { state: "current" }>;
  /** Some of its incidents are known: another of its sources answered. */
  partly: boolean;
}

/**
 * The products whose incident data is not complete, for the Past incidents
 * and Recent incidents notes. `known` are the incidents at hand, which tell
 * whether another of a product's sources answered.
 */
export function missingIncidents(
  products: readonly ProductSummary[],
  known: readonly Incident[],
): MissingIncidents[] {
  return products.flatMap((product) => {
    const coverage = incidentCoverage(product);
    if (coverage.state === "current") return [];
    return [{ product, coverage, partly: someIncidentsKnown(product, known) }];
  });
}

/** Of `missing`, the products whose incident data does not cover everything before `end`. */
export function notCoveredBefore(
  missing: readonly MissingIncidents[],
  end: Date,
): MissingIncidents[] {
  return missing.filter(
    (m) => m.coverage.state === "never" || m.coverage.at.getTime() < end.getTime(),
  );
}

/** The last successful fetch of a product's incidents that stopped answering, else null. */
export function completeUntil(product: ProductSummary): Date | null {
  const coverage = incidentCoverage(product);
  return coverage.state === "until" ? coverage.at : null;
}
