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

import type { ProductSummary } from "../api/types";
import { config } from "../config";

export interface Freshness {
  /** Age of the data, or null when no check time applies. */
  ageMs: number | null;
  /** True when the data is older than the limit or the API cannot be reached. */
  outdated: boolean;
  /**
   * True when the latest attempt failed and the last success is older than
   * the limit, or when the latest response was already too old on arrival.
   */
  unavailable: boolean;
}

/** Never negative: a clock slightly behind the server's reads as no age, not a future one. */
const ageOf = (now: Date, at: Date | null): number | null =>
  at ? Math.max(0, now.getTime() - at.getTime()) : null;

/**
 * How far this browser's clock is ahead of the server's, from one response:
 * the time it arrived minus the server's clock when it was sent. Zero when the
 * server's clock is unknown. Ages of server times (the body's generated_at
 * and checked_at) are measured on the server's clock, so a visitor's wrong
 * clock does not change them. The network time counts as skew, which
 * shortens ages by that much.
 */
export function clockSkew(receivedAt: Date, serverNow: Date | null): number {
  return serverNow === null ? 0 : receivedAt.getTime() - serverNow.getTime();
}

/**
 * True when a response's generated_at was longer ago than the limit at the
 * moment it was sent (`serverNow`, the server's clock, or the arrival time
 * when that is unknown): a frozen service, or a CDN copy served under
 * stale-if-error. Measured once, on arrival, so a tab back from the
 * background does not flash "Status unavailable" before its refresh answers.
 */
export function staleOnArrival(serverNow: Date, generatedAt: Date | null): boolean {
  const age = ageOf(serverNow, generatedAt);
  return age !== null && age > config.staleAfterMs;
}

export interface FreshnessInputs {
  /** When the data shown was last checked, a server-clock time; null when no time applies. */
  checkedAt: Date | null;
  /** This browser's last successful fetch, a client-clock time. */
  lastSuccessAt: Date | null;
  failed: boolean;
  /** The latest response was already too old on arrival (see staleOnArrival). */
  servedStale?: boolean;
  /** This browser's clock minus the server's (see clockSkew). */
  skewMs?: number;
}

/**
 * The age is that of `checkedAt`, measured on the server's clock. A failure
 * makes the data `unavailable` only when the latest attempt failed: a tab
 * back from the background whose last attempt succeeded refreshes at once.
 * A request that never answers fails when it times out
 * (config.requestTimeoutMs). A response that was already too old on arrival
 * counts like a failed refresh.
 */
export function freshness(now: Date, inputs: FreshnessInputs): Freshness {
  const { checkedAt, lastSuccessAt, failed, servedStale = false, skewMs = 0 } = inputs;
  const ageMs = ageOf(new Date(now.getTime() - skewMs), checkedAt);
  const sinceSuccess = ageOf(now, lastSuccessAt);
  return {
    ageMs,
    outdated: failed || servedStale || (ageMs !== null && ageMs > config.staleAfterMs),
    unavailable:
      servedStale || (failed && sinceSuccess !== null && sinceSuccess > config.staleAfterMs),
  };
}

/** A product whose component data is past its staleness or was never received. */
export interface LateProduct {
  name: string;
  /** Its status is known: only part of its data is late (a multi-source product). */
  partly: boolean;
  /** Its last successful component check; null when one of its sources never answered. */
  at: Date | null;
}

interface ComponentFreshness {
  /**
   * The age line's time: the oldest component check among products with a
   * known status and current data. Null when no product has current data;
   * the late products are then named with their own times instead.
   */
  checkedAt: Date | null;
  late: LateProduct[];
}

/**
 * The banner's freshness: one silent source does not age the whole page.
 * The age line covers the products whose data is current, and each late
 * product is named with its own time.
 */
export function componentFreshness(products: readonly ProductSummary[]): ComponentFreshness {
  let checkedAt: Date | null = null;
  const late: LateProduct[] = [];
  for (const p of products) {
    const at = p.freshness.checkedAt.components;
    if (at === null || p.freshness.stale.components) {
      late.push({ name: p.name, partly: p.status !== "unknown", at });
    } else if (
      p.status !== "unknown" &&
      (checkedAt === null || at.getTime() < checkedAt.getTime())
    ) {
      checkedAt = at;
    }
  }
  return { checkedAt, late };
}

/** Where a product's incident data ends. */
export type IncidentCoverage =
  | { state: "current" }
  /** Never received from (one of) its sources: no time to name. */
  | { state: "never" }
  /** Stopped after answering: complete until `at` (server clock), the last successful fetch. */
  | { state: "until"; at: Date };

export function incidentCoverage(product: ProductSummary): IncidentCoverage {
  const { stale, checkedAt } = product.freshness;
  if (!stale.incidents) return { state: "current" };
  return checkedAt.incidents === null
    ? { state: "never" }
    : { state: "until", at: checkedAt.incidents };
}
