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

import type { Incident, Status } from "../api/types";
import { STATUS_RANK } from "./status";
import { formatDayHeading, lastLocalDays, localDayKey } from "./time";

export interface DayGroup {
  key: string;
  label: string;
  /** This local midnight. */
  start: Date;
  /** The next local midnight: data covering everything before it covers this day. */
  end: Date;
  incidents: Incident[];
}

/**
 * The incident list caught up with a newer summary. The two are polled
 * apart, so for up to a poll the summary can name an active incident the list
 * does not have yet, or a newer state of one; each active incident of a newer
 * summary then joins or replaces the list's copy. A list as new as the summary
 * is taken as it is.
 */
export function caughtUp(
  list: readonly Incident[],
  listAt: Date | null,
  active: readonly Incident[],
  summaryAt: Date | null,
): readonly Incident[] {
  if (summaryAt === null || active.length === 0) return list;
  if (listAt !== null && listAt.getTime() >= summaryAt.getTime()) return list;
  const byId = new Map(list.map((i) => [i.id, i]));
  for (const incident of active) byId.set(incident.id, incident);
  return [...byId.values()];
}

/** Whether an incident covers part of [start, end): it started then, or was still going at start. */
function overlaps(incident: Incident, start: number, end: number, now: Date): boolean {
  const from = incident.startedAt.getTime();
  if (from >= end) return false;
  return from >= start || (incident.resolvedAt ?? now).getTime() > start;
}

/**
 * Incidents under every local day they cover, newest day first, empty days
 * included: one that started the evening before, or is still going, also
 * counts for the days after. Within a day, the latest start comes first.
 */
export function groupByDay(incidents: readonly Incident[], now: Date, days: number): DayGroup[] {
  return lastLocalDays(now, days).map((start) => {
    const end = new Date(start.getFullYear(), start.getMonth(), start.getDate() + 1);
    const found = incidents.filter((i) => overlaps(i, start.getTime(), end.getTime(), now));
    return {
      key: localDayKey(start),
      label: formatDayHeading(start),
      start,
      end,
      incidents: [...found].sort((a, b) => b.startedAt.getTime() - a.startedAt.getTime()),
    };
  });
}

export function isOngoing(incident: Incident): boolean {
  return incident.resolvedAt === null;
}

/** To its end, or for an open incident to `until` (now, or when it was last known). */
export function incidentDuration(incident: Incident, until: Date): number {
  return (incident.resolvedAt ?? until).getTime() - incident.startedAt.getTime();
}

/** "Investigating" from "investigating"; empty stays empty. */
export function stateLabel(state: string): string {
  return state === "" ? "" : state.charAt(0).toUpperCase() + state.slice(1).toLowerCase();
}

export function worstImpact(incidents: readonly Incident[]): Status {
  return incidents.reduce<Status>(
    (worst, i) => (STATUS_RANK[i.impact] > STATUS_RANK[worst] ? i.impact : worst),
    "unknown",
  );
}
