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

import type { Day, Incident, Status } from "../api/types";
import { DAY_LABEL, IMPACT_LABEL, STATUS_RANK, incidentsCompleteUntil } from "./status";
import { formatDuration, formatHistoryDate, formatUtcClock, utcDayKey } from "./time";

interface HistorySummary {
  withIncidents: number;
  withoutData: number;
}

export function summariseHistory(days: readonly Day[]): HistorySummary {
  return {
    withIncidents: days.filter((d) => STATUS_RANK[d.status] > STATUS_RANK.operational).length,
    withoutData: days.filter((d) => d.status === "unknown").length,
  };
}

/** Text read by assistive technology for the whole strip. */
export function historyText(days: readonly Day[]): string {
  const { withIncidents, withoutData } = summariseHistory(days);
  const unit = (n: number) => `${String(n)} ${n === 1 ? "day" : "days"}`;
  return `${String(days.length)} days: ${unit(withIncidents)} with incidents, ${unit(withoutData)} without data`;
}

export interface DayDetail {
  heading: string;
  status: Status;
  statusLabel: string;
  minutes: { label: string; text: string }[];
  titles: string[];
  /** On the day the incident data ends: until when it is complete. */
  note: string | null;
}

const MINUTE_ORDER: Status[] = ["outage", "degraded", "maintenance"];
const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

/** Time the half-open spans [from, to) cover, overlaps counted once. */
function union(spans: [number, number][]): number {
  const sorted = [...spans].sort((a, b) => a[0] - b[0]);
  let total = 0;
  let end = -Infinity;
  for (const [from, to] of sorted) {
    if (to <= end) continue;
    total += to - Math.max(from, end);
    end = to;
  }
  return total;
}

function apiTimes(day: Day): Partial<Record<Status, number>> {
  return Object.fromEntries(
    Object.entries(day.minutes).map(([status, minutes]) => [status, minutes * MINUTE]),
  );
}

/**
 * Time of each impact during the day, in milliseconds. When every incident
 * of the day is at hand, it is computed here the way the API does (the union
 * per impact, an unknown impact counting as degraded, an open incident up to
 * `now`, or up to `completeUntil` when its feed stopped), so the strip and the
 * incident list show the same duration from the same clock. Otherwise the
 * API's whole minutes are used.
 */
function impactTimes(
  day: Day,
  incidents: ReadonlyMap<string, Incident>,
  now: Date,
  completeUntil: Date | null,
): Partial<Record<Status, number>> {
  const known = day.incidentIds.flatMap((id) => {
    const incident = incidents.get(id);
    return incident ? [incident] : [];
  });
  if (known.length === 0 || known.length < day.incidentIds.length) return apiTimes(day);
  const start = Date.parse(`${day.date}T00:00:00Z`);
  const end = Math.min(start + DAY, now.getTime());
  const spans = new Map<Status, [number, number][]>();
  for (const incident of known) {
    const from = Math.max(incident.startedAt.getTime(), start);
    const to = Math.min((incident.resolvedAt ?? completeUntil ?? now).getTime(), end);
    // An incident that does not overlap the day by this clock: keep the API's figures.
    if (to <= from) return apiTimes(day);
    const impact = incident.impact === "unknown" ? "degraded" : incident.impact;
    spans.set(impact, [...(spans.get(impact) ?? []), [from, to]]);
  }
  return Object.fromEntries([...spans].map(([status, list]) => [status, union(list)]));
}

/**
 * History days are UTC calendar days, and every heading says so.
 * `completeUntil` is the last successful fetch of a product's incidents that
 * stopped answering: the day that contains it is only partly covered.
 */
export function dayDetail(
  day: Day,
  incidents: ReadonlyMap<string, Incident>,
  now: Date,
  completeUntil: Date | null = null,
): DayDetail {
  const times = impactTimes(day, incidents, now, completeUntil);
  const partial = completeUntil !== null && utcDayKey(completeUntil) === day.date;
  return {
    note: partial ? incidentsCompleteUntil(formatUtcClock(completeUntil)) : null,
    heading: `${formatHistoryDate(day.date)} (UTC)`,
    status: day.status,
    statusLabel: DAY_LABEL[day.status],
    minutes: MINUTE_ORDER.flatMap((status) => {
      const ms = times[status];
      return ms ? [{ label: IMPACT_LABEL[status], text: formatDuration(ms) }] : [];
    }),
    titles: day.incidentIds.flatMap((id) => {
      const incident = incidents.get(id);
      return incident ? [incident.title] : [];
    }),
  };
}

/** One sentence for the focused cell. */
export function dayAriaLabel(detail: DayDetail): string {
  const parts = [`${detail.heading}: ${detail.statusLabel}`];
  for (const m of detail.minutes) parts.push(`${m.label} ${m.text}`);
  if (detail.titles.length > 0) parts.push(`Incidents: ${detail.titles.join("; ")}`);
  const text = parts.join(". ");
  return detail.note === null ? text : `${text}. ${detail.note}`;
}

/**
 * Captions under the strip: the first day's date on the left; on the right,
 * "Today" when the last day is today in UTC, else that day's date.
 */
export function stripCaptions(days: readonly Day[], today: string): [string, string] {
  const first = days[0];
  const last = days.at(-1);
  if (!first || !last) return ["", ""];
  return [
    formatHistoryDate(first.date),
    last.date === today ? "Today" : formatHistoryDate(last.date),
  ];
}
