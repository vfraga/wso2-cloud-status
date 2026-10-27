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
import { formatDayHeading, localDayKey, localMonthKey } from "./time";

export interface DayGroup {
  /** The local day, "2026-10-20". */
  key: string;
  label: string;
  incidents: Incident[];
}

/**
 * Incidents under the reader's local day they started, the latest day first
 * and, within a day, the latest start first. Each incident is listed once;
 * one that ran past midnight says when it ended.
 */
export function byStartDay(incidents: readonly Incident[]): DayGroup[] {
  const groups = new Map<string, DayGroup>();
  const latestFirst = [...incidents].sort((a, b) => b.startedAt.getTime() - a.startedAt.getTime());
  for (const incident of latestFirst) {
    const key = localDayKey(incident.startedAt);
    const group = groups.get(key) ?? {
      key,
      label: formatDayHeading(incident.startedAt),
      incidents: [],
    };
    group.incidents.push(incident);
    groups.set(key, group);
  }
  return [...groups.values()];
}

/**
 * Incidents by the reader's local month they started, keyed "2026-10", each
 * month's latest start first.
 */
export function byStartMonth(incidents: readonly Incident[]): Map<string, Incident[]> {
  const months = new Map<string, Incident[]>();
  const latestFirst = [...incidents].sort((a, b) => b.startedAt.getTime() - a.startedAt.getTime());
  for (const incident of latestFirst) {
    const key = localMonthKey(incident.startedAt);
    months.set(key, [...(months.get(key) ?? []), incident]);
  }
  return months;
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
