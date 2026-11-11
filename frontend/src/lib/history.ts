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
import {
  count,
  DAY_LABEL,
  IMPACT_LABEL,
  incidentCount,
  incidentsCompleteUntil,
  isProblem,
  notYetReported,
  STATUS_LABEL,
  STATUS_RANK,
} from "./status";
import { formatDuration, formatHistoryDate, formatUtcClock, utcDayKey } from "./time";

interface HistorySummary {
  /** Incidents other than maintenance on these days, each once however many days it touches. */
  incidents: number;
  maintenance: number;
  withoutData: number;
}

const DAY = 24 * 60 * 60_000;

/**
 * Whether the incident touches [from, to) as the API's history counts it: it
 * overlaps the span, or it is zero-length inside it; an open incident runs on.
 */
function touches(incident: Incident, from: number, to: number): boolean {
  const start = incident.startedAt.getTime();
  if (start >= to) return false;
  if (incident.resolvedAt === null) return true;
  const end = incident.resolvedAt.getTime();
  return end > from || (end === start && start >= from);
}

/**
 * Counts incidents, not days: one that crosses UTC midnight colours two days
 * but is one incident, as the incident list shows it. A day names at most a
 * few incidents (the API keeps the most severe), so the count also takes
 * every incident of the product's list that touches these days.
 */
export function summariseHistory(
  days: readonly Day[],
  incidents: ReadonlyMap<string, Incident>,
): HistorySummary {
  const ids = new Set(days.flatMap((d) => d.incidentIds));
  const first = days[0];
  const last = days.at(-1);
  if (first && last) {
    const from = Date.parse(`${first.date}T00:00:00Z`);
    const to = Date.parse(`${last.date}T00:00:00Z`) + DAY;
    for (const [id, incident] of incidents) if (touches(incident, from, to)) ids.add(id);
  }
  const maintenance = [...ids].filter((id) => incidents.get(id)?.impact === "maintenance").length;
  return {
    incidents: ids.size - maintenance,
    maintenance,
    withoutData: days.filter((d) => d.status === "unknown").length,
  };
}

/** Text read by assistive technology for the whole strip. */
export function historyText(
  days: readonly Day[],
  incidents: ReadonlyMap<string, Incident>,
): string {
  const summary = summariseHistory(days, incidents);
  return `${count(days.length, "day")}: ${incidentCount(summary.incidents, summary.maintenance)}, ${count(summary.withoutData, "day")} without data`;
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

/**
 * Time of each impact during the day, in milliseconds: the API's minutes,
 * which count every incident of the day (overlaps once, an open incident up
 * to the snapshot's minute or to when its feed stopped). One source, so the
 * figure never depends on which of the day's incidents the page holds.
 */
function impactTimes(day: Day): Partial<Record<Status, number>> {
  return Object.fromEntries(
    Object.entries(day.minutes).map(([status, minutes]) => [status, minutes * MINUTE]),
  );
}

/**
 * The days as far as the data vouches for them. From the UTC day that holds
 * `completeUntil` on (where a product's incident feed, or the page's own
 * data, stops), a day with no known problem reads unknown ("No data"), not
 * quiet: statusd applies the same rule to a feed that stopped.
 */
export function coveredDays(days: readonly Day[], completeUntil: Date | null): readonly Day[] {
  if (completeUntil === null) return days;
  const from = utcDayKey(completeUntil);
  return days.map((day) =>
    day.date >= from && !isProblem(day.status) ? { ...day, status: "unknown" } : day,
  );
}

/**
 * Whether the day is today and its status comes from a region's current
 * status rather than from the incidents filed for it (statusd raises today
 * so: no incident filed yet).
 */
function aheadOfIncidents(day: Day, incidents: ReadonlyMap<string, Incident>, now: Date): boolean {
  if (day.date !== utcDayKey(now) || !isProblem(day.status)) return false;
  const worst = Math.max(
    STATUS_RANK.operational,
    ...day.incidentIds.map((id) => {
      const impact = incidents.get(id)?.impact ?? "unknown";
      // An unknown impact counts as degraded, as everywhere else.
      return STATUS_RANK[impact === "unknown" ? "degraded" : impact];
    }),
  );
  return STATUS_RANK[day.status] > worst;
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
  const times = impactTimes(day);
  const partial = completeUntil !== null && utcDayKey(completeUntil) === day.date;
  const notes = [
    ...(aheadOfIncidents(day, incidents, now) ? [notYetReported(STATUS_LABEL[day.status])] : []),
    ...(partial ? [incidentsCompleteUntil(formatUtcClock(completeUntil))] : []),
  ];
  return {
    note: notes.length === 0 ? null : notes.join(" "),
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
