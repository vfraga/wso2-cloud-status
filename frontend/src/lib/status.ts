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

import type { Status } from "../api/types";

/*
 * Every word the page uses for a status, in one place and in sentence case,
 * so the banner, rows, regions, incidents and notes never name the same
 * state differently.
 */

export const STATUS_RANK: Record<Status, number> = {
  unknown: 0,
  operational: 1,
  maintenance: 2,
  degraded: 3,
  outage: 4,
};

/** Maintenance, degraded or outage: something a reader should look at. */
export const isProblem = (status: Status): boolean => STATUS_RANK[status] > STATUS_RANK.operational;

/** Short label for products, regions and components. */
export const STATUS_LABEL: Record<Status, string> = {
  operational: "Operational",
  maintenance: "Under maintenance",
  degraded: "Degraded performance",
  outage: "Service outage",
  unknown: "Status unavailable",
};

/** Banner headline for a rolled-up status. */
export const BANNER_LABEL: Record<Status, string> = {
  ...STATUS_LABEL,
  operational: "All systems operational",
};

/** Label for a day cell in the history strip. */
export const DAY_LABEL: Record<Status, string> = {
  ...STATUS_LABEL,
  operational: "No incidents",
  unknown: "No data",
};

/**
 * Impact of an incident. An impact the API does not know counts as degraded
 * in the roll-up (ADR 0004); it is a declared incident, not missing data.
 */
export const IMPACT_LABEL: Record<Status, string> = {
  ...STATUS_LABEL,
  operational: "No impact",
  unknown: "Unknown impact",
};

export const CHECKING_LABEL = "Checking status";
/** Banner headline when every known status is operational but some data is missing. */
export const PARTIAL_HEADLINE = "Some status data is unavailable";
/** Row label for an operational product with some data missing. */
export const PARTIAL_LABEL = "Some data unavailable";
export const UPTIME_LABEL = "Uptime (outages only, updated daily)";
export const UPTIME_SHORT_LABEL = "Uptime";
export const COMPONENTS_UNAVAILABLE = "some component data is unavailable";

/** The text with its first letter in upper case, for a fragment that starts a line. */
export function capitalise(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** "1 day", "2 days"; `plural` defaults to the singular plus "s". */
export function count(n: number, singular: string, plural = `${singular}s`): string {
  return `${String(n)} ${n === 1 ? singular : plural}`;
}

/** "A", "A and B", "A, B and C". */
export function listNames(names: readonly string[]): string {
  if (names.length <= 1) return names.join("");
  return `${names.slice(0, -1).join(", ")} and ${names.at(-1) ?? ""}`;
}

export function unavailableFor(names: readonly string[]): string {
  return `Status unavailable for ${listNames(names)}`;
}

export function regionsAffected(affected: number, total: number): string {
  return `${String(affected)} of ${count(total, "region")} affected`;
}

export function regionsUnavailable(unavailable: number, total: number): string {
  return `${String(unavailable)} of ${count(total, "region")} unavailable`;
}

export function othersOperational(n: number): string {
  return n === 1
    ? "The other product is operational."
    : `The other ${String(n)} products are operational.`;
}

export function daysWithIncidents(n: number): string {
  return `${count(n, "day")} with incidents`;
}

export function incidentInfoUnavailable(name: string): string {
  return `Incident information for ${name} is unavailable right now.`;
}

/** A product with several sources, one of which never sent its incidents while others did. */
export function incidentInfoPartlyUnavailable(name: string): string {
  return `Incident information for ${name} is incomplete right now.`;
}

/** An incident feed that answered and then stopped; `when` is a UTC date and time. */
export function incidentInfoIncompleteAfter(name: string, when: string): string {
  return `Incident information for ${name} is incomplete after ${when}.`;
}

/** The banner's line for such a feed, in the row's words; `time` is a UTC time. */
export function incidentsNotUpdated(name: string, time: string): string {
  return `Incident information for ${name} has not been updated since ${time}.`;
}

/** Tooltip line on the history day that contains the last successful fetch. */
export function incidentsCompleteUntil(time: string): string {
  return `Incident information complete only until ${time}.`;
}

/** How long an incident lasted, or has lasted so far; `duration` is "1h 12m". */
export function lasted(duration: string): string {
  return `Lasted ${duration}.`;
}
export function ongoingFor(duration: string): string {
  return `Ongoing for ${duration}.`;
}

/**
 * Under an ongoing incident whose feed stopped: how long it had lasted when
 * last known, which does not grow, and when that was; it may have changed since.
 */
export function ongoingAsOf(duration: string, time: string): string {
  return `Ongoing for at least ${duration}. Last known as of ${time}.`;
}

/** Row lines for a stale incident or uptime feed: a UTC time and "12 min ago". */
export function incidentsLastUpdated(time: string, ago: string): string {
  return `Incidents last updated ${time} (${ago})`;
}
export function uptimeLastUpdated(time: string, ago: string): string {
  return `Uptime last updated ${time} (${ago})`;
}
/** The same when the feed never answered, so there is no time to give. */
export const INCIDENTS_UNAVAILABLE_LABEL = "Incident information unavailable";
export const UPTIME_UNAVAILABLE_LABEL = "Uptime unavailable";
/** The same for a product with several sources when another source's data is shown. */
export const INCIDENTS_INCOMPLETE_LABEL = "Incident information incomplete";
export const UPTIME_INCOMPLETE_LABEL = "Uptime incomplete";

/** Banner notes for products whose component data is late; names joined with listNames. */
export function noStatusDataYet(names: string, partly: boolean): string {
  return partly
    ? `Some status data has not been received yet for ${names}.`
    : `No status data has been received yet for ${names}.`;
}
export function statusDataLastChecked(names: string, time: string, partly: boolean): string {
  return partly
    ? `Some status data for ${names} was last checked at ${time}.`
    : `Status data for ${names} was last checked at ${time}.`;
}

/**
 * The banner's age line: when the statuses shown were last checked, in whole
 * minutes ("less than a minute ago"), as precise as the API's times.
 */
export function statusChecked(ago: string): string {
  return `Status checked ${ago}`;
}
/** The same when some products are late and named in the notice with their own times. */
export function othersChecked(ago: string): string {
  return `Other products checked ${ago}`;
}

/** Read by assistive technology when the headline changes on an open page. */
export function statusChanged(label: string): string {
  return `Status changed: ${label}.`;
}

/** A product page's Recent incidents with complete data and nothing to list. */
export const NO_INCIDENTS = "No incidents reported.";
/** The same when its only incidents are ongoing, listed under Active incidents. */
export const NO_OTHER_INCIDENTS = "No other incidents reported.";

export const PAST_INCIDENTS_LOADING = "Loading past incidents.";
export const PAST_INCIDENTS_UNAVAILABLE = "Past incidents could not be loaded.";
export const PAST_INCIDENTS_FAILED =
  "Past incidents could not be refreshed just now, so this list may be out of date.";
export function pastIncidentsStale(limit: string): string {
  return `Past incidents were last refreshed more than ${limit} ago, so this list may be out of date.`;
}

/** The history strip legend. */
export const LEGEND_INTRO = "Each bar is one UTC day.";
export const LEGEND_INCIDENTS = "Incidents";
export const LEGEND_QUIET = "No incidents";
export const LEGEND_NO_DATA = "No data: information for this day is unavailable";

/** The page that replaces the app when rendering fails. */
export const RENDER_FAILED = "Something went wrong showing this page";
export const RENDER_FAILED_DETAIL =
  "This page will try again on its own. Meanwhile, check each product's own status page:";

export const FOOTER_TIMES =
  "Times are shown in your local time zone unless marked UTC. History bars are UTC calendar days.";

/** Text for a day without incidents when the incident data of `missing` of `total` products is unavailable. */
export function quietDayText(missing: number, total: number): string {
  if (missing >= total) return "No incident information is available.";
  if (missing === 0) return NO_INCIDENTS;
  return total - missing === 1
    ? "No incidents reported for the other product."
    : "No incidents reported for the other products.";
}
