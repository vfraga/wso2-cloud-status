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

/*
 * Every date, time and age the page shows comes from this module. All of
 * them go through Intl in the reader's locale, so one page has one hour cycle
 * and one date style. Times about the data (when it was checked, where an
 * incident feed ends) and the history days are UTC and say so; incident
 * times are in the reader's zone, as the footer says.
 */

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

const shortDate = { year: "numeric", month: "short", day: "numeric" } as const;
const clockParts = { hour: "numeric", minute: "2-digit", timeZoneName: "short" } as const;

const utcClock = new Intl.DateTimeFormat(undefined, { ...clockParts, timeZone: "UTC" });
const utcDate = new Intl.DateTimeFormat(undefined, { ...shortDate, timeZone: "UTC" });
const utcDateClock = new Intl.DateTimeFormat(undefined, {
  ...shortDate,
  ...clockParts,
  timeZone: "UTC",
});
const localClock = new Intl.DateTimeFormat(undefined, clockParts);
const localDateClock = new Intl.DateTimeFormat(undefined, {
  month: "short",
  day: "numeric",
  ...clockParts,
});
/** The earliest of the times given, ignoring nulls; null when there is none. */
export function earliest(...times: (Date | null)[]): Date | null {
  return times.reduce<Date | null>(
    (min, t) => (t !== null && (min === null || t.getTime() < min.getTime()) ? t : min),
    null,
  );
}

/** UTC calendar day key, "2026-10-20". */
export function utcDayKey(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** "2:05 PM UTC" (en-US), "14:05 UTC" (en-GB). */
export function formatUtcClock(date: Date): string {
  return utcClock.format(date);
}

/** "Oct 21, 2026, 2:05 PM UTC" (en-US). */
export function formatUtcDateTime(date: Date): string {
  return utcDateClock.format(date);
}

/** The UTC clock on the same UTC day as `now`, else the UTC date and clock. */
export function formatUtcTime(date: Date, now: Date): string {
  return utcDayKey(date) === utcDayKey(now) ? formatUtcClock(date) : formatUtcDateTime(date);
}

/** A history day (a UTC calendar day), "Oct 20, 2026" (en-US); the text as is when it is no date. */
export function formatHistoryDate(isoDate: string): string {
  const day = new Date(`${isoDate}T00:00:00Z`);
  return Number.isNaN(day.getTime()) ? isoDate : utcDate.format(day);
}

/** Local time of day with zone, "10:41 AM GMT+2" (en-US). */
export function formatClock(date: Date): string {
  return localClock.format(date);
}

/** Local date and time with zone, "Oct 21, 10:41 AM GMT+2" (en-US). */
export function formatDateClock(date: Date): string {
  return localDateClock.format(date);
}

function plural(n: number, unit: string): string {
  return `${String(n)} ${unit}${n === 1 ? "" : "s"}`;
}

/** "just now", "12 min ago", "3 hours ago", "2 days ago": whole units. */
function formatAgo(ms: number): string {
  const minutes = Math.floor(Math.max(0, ms) / MINUTE);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${String(minutes)} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${plural(hours, "hour")} ago`;
  return `${plural(Math.floor(hours / 24), "day")} ago`;
}

/**
 * The age of a check time, which the API floors to the minute: the check
 * was made during that minute, and the time can trail the latest check by
 * up to a minute more. While the data is current the age counts from the
 * end of the minute, the time known to have passed, so a fresh load reads
 * "just now". Once the data is past its limit the age counts from the start
 * of the minute, as the limits do, so it never reads under a limit the page
 * says has passed, and agrees with the time shown beside it.
 */
export function formatCheckAge(ms: number, outdated: boolean): string {
  return formatAgo(outdated ? ms : ms - MINUTE);
}

/** "1h 12m", "45m", "2d 3h", "under 1m". */
export function formatDuration(ms: number): string {
  const total = Math.max(0, ms);
  if (total < MINUTE) return "under 1m";
  if (total >= DAY) {
    const hours = Math.floor((total % DAY) / HOUR);
    const days = `${String(Math.floor(total / DAY))}d`;
    return hours > 0 ? `${days} ${String(hours)}h` : days;
  }
  const hours = Math.floor(total / HOUR);
  const minutes = Math.floor((total % HOUR) / MINUTE);
  if (hours === 0) return `${String(minutes)}m`;
  return minutes > 0 ? `${String(hours)}h ${String(minutes)}m` : `${String(hours)}h`;
}

/** "5 minutes", "1 minute"; never less than one minute. */
export function formatMinutes(ms: number): string {
  return plural(Math.max(1, Math.round(ms / MINUTE)), "minute");
}
