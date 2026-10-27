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

import {
  STATUSES,
  type Component,
  type Day,
  type Group,
  type Incident,
  type IncidentList,
  type IncidentListProduct,
  type Location,
  type PerKind,
  type ProductDetail,
  type ProductFreshness,
  type ProductSummary,
  type RegionDetail,
  type RegionSummary,
  type Status,
  type Summary,
  type Uptime,
} from "./types";

/*
 * The API is typed by contract, but the page must never crash on a field it
 * does not know. Every reader here falls back to a safe value instead.
 */

type Rec = Record<string, unknown>;

const isRec = (v: unknown): v is Rec => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown, fallback = ""): string => (typeof v === "string" ? v : fallback);
const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const records = (v: unknown): Rec[] => list(v).filter(isRec);

export function toStatus(v: unknown): Status {
  return STATUSES.find((s) => s === v) ?? "unknown";
}

export function toDate(v: unknown): Date | null {
  if (typeof v !== "string") return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

function optionalString(key: string, v: unknown): Record<string, string> {
  return typeof v === "string" && v !== "" ? { [key]: v } : {};
}

function toUptime(r: Rec): Uptime[] {
  return records(r.uptime).flatMap((u) => {
    const percent = u.percent;
    return typeof percent === "number" && Number.isFinite(percent)
      ? [{ window: str(u.window), percent }]
      : [];
  });
}

function toComponent(r: Rec): Component {
  return {
    name: str(r.name, "Unnamed component"),
    status: toStatus(r.status),
    uptime: toUptime(r),
    ...optionalString("description", r.description),
    ...optionalString("message", r.message),
  };
}

function toGroup(r: Rec): Group {
  return {
    name: str(r.name, "Components"),
    status: toStatus(r.status),
    components: records(r.components).map(toComponent),
  };
}

function toRegion(r: Rec): RegionSummary | null {
  const id = str(r.id);
  if (id === "") return null;
  return {
    id,
    name: str(r.name, id),
    status: toStatus(r.status),
    uptime: toUptime(r),
    ...optionalString("location", r.location),
  };
}

function toRegionDetail(r: Rec): RegionDetail | null {
  const base = toRegion(r);
  if (!base) return null;
  return { ...base, groups: records(r.groups).map(toGroup) };
}

/** A location without an id is dropped; its regions are then listed on their own. */
function toLocation(r: Rec): Location | null {
  const id = str(r.id);
  if (id === "") return null;
  return { id, name: str(r.name, id), status: toStatus(r.status) };
}

function toMinutes(v: unknown): Day["minutes"] {
  const out: Day["minutes"] = {};
  if (!isRec(v)) return out;
  for (const status of STATUSES) {
    const n = v[status];
    if (typeof n === "number" && n > 0) out[status] = n;
  }
  return out;
}

/** Whether `date` is a real calendar day, "2026-10-20"; "2026-13-45" is not. */
function isCalendarDay(date: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return false;
  const day = new Date(`${date}T00:00:00Z`);
  return !Number.isNaN(day.getTime()) && day.toISOString().slice(0, 10) === date;
}

function toDay(r: Rec): Day | null {
  const date = str(r.date);
  if (!isCalendarDay(date)) return null;
  return {
    date,
    status: toStatus(r.status),
    minutes: toMinutes(r.minutes),
    incidentIds: list(r.incident_ids).filter((x): x is string => typeof x === "string"),
  };
}

function toIncident(r: Rec): Incident | null {
  const startedAt = toDate(r.started_at);
  const id = str(r.id);
  if (!startedAt || id === "") return null;
  return {
    id,
    productId: str(r.product_id),
    title: str(r.title, "Incident"),
    impact: toStatus(r.impact),
    state: str(r.state),
    startedAt,
    resolvedAt: toDate(r.resolved_at),
  };
}

function nonNull<T>(v: T | null): v is T {
  return v !== null;
}

function parseIncidents(raw: unknown): Incident[] {
  return records(raw).map(toIncident).filter(nonNull);
}

/** Whether `raw` is a list whose every record could be read. */
function allReadable(raw: unknown): boolean {
  return Array.isArray(raw) && raw.every((r) => isRec(r) && toIncident(r) !== null);
}

const KINDS = ["components", "incidents", "uptime"] as const;

/**
 * checked_at and stale. Fails closed: a kind is stale unless the API says
 * false and its time could be read, so a product without these fields reads
 * as stale for every kind.
 */
function toFreshness(r: Rec): ProductFreshness {
  const at = isRec(r.checked_at) ? r.checked_at : {};
  const flags = isRec(r.stale) ? r.stale : {};
  const checkedAt = { components: null, incidents: null, uptime: null } as PerKind<Date | null>;
  const stale = { components: true, incidents: true, uptime: true } as PerKind<boolean>;
  for (const kind of KINDS) {
    checkedAt[kind] = toDate(at[kind]);
    stale[kind] = checkedAt[kind] === null || flags[kind] !== false;
  }
  return { checkedAt, stale };
}

function toProduct(r: Rec): ProductSummary | null {
  const id = str(r.id);
  if (id === "") return null;
  const sent = list(r.regions);
  const regions = records(sent).map(toRegion).filter(nonNull);
  const sentLocations = list(r.locations);
  const locations = records(sentLocations).map(toLocation).filter(nonNull);
  return {
    id,
    name: str(r.name, id),
    status: toStatus(r.status),
    // Fails closed: complete only when the API says so, sent both lists,
    // every region and location in them could be read, and no region is
    // unknown.
    dataComplete:
      r.data_complete === true &&
      Array.isArray(r.regions) &&
      Array.isArray(r.locations) &&
      regions.length === sent.length &&
      locations.length === sentLocations.length &&
      regions.every((x) => x.status !== "unknown"),
    freshness: toFreshness(r),
    locations,
    regions,
    history: records(r.history).map(toDay).filter(nonNull),
    ...optionalString("description", r.description),
  };
}

/** The freshness of a product whose incidents count as not received: stale, with no time. */
function incidentsNotReceived(freshness: ProductFreshness): ProductFreshness {
  return {
    checkedAt: { ...freshness.checkedAt, incidents: null },
    stale: { ...freshness.stale, incidents: true },
  };
}

/**
 * The products whose incidents an unreadable active incident may belong to:
 * its product's id when that can be read, else every product ("").
 */
function unreadableActive(raw: unknown): Set<string> {
  if (!Array.isArray(raw)) return new Set([""]);
  return new Set(
    raw
      .filter((x) => !isRec(x) || toIncident(x) === null)
      .map((x) => (isRec(x) ? str(x.product_id) : "")),
  );
}

export function parseSummary(raw: unknown): Summary {
  const r = isRec(raw) ? raw : {};
  const sent = list(r.products);
  // An active incident the page cannot read counts as incident data not
  // received for its product, never as no incident.
  const unreadable = unreadableActive(r.active_incidents);
  const products = records(sent)
    .map(toProduct)
    .filter(nonNull)
    .map((p) =>
      unreadable.has("") || unreadable.has(p.id)
        ? { ...p, freshness: incidentsNotReceived(p.freshness) }
        : p,
    );
  // Fails closed: a missing field, a product record that could not be read
  // or an empty list counts as incomplete. The products are checked even
  // when the API says complete, so the two cannot disagree.
  const dataComplete =
    r.data_complete === true &&
    products.length > 0 &&
    products.length === sent.length &&
    products.every((p) => p.dataComplete && p.status !== "unknown");
  const status = toStatus(r.status);
  return {
    // The API's status, except that "operational" over data the page cannot
    // read in full reads unknown. A problem status is never made healthier.
    status: status === "operational" && !dataComplete ? "unknown" : status,
    dataComplete,
    products,
    activeIncidents: parseIncidents(r.active_incidents),
  };
}

/**
 * A product's incidents that are missing or partly unreadable count as not
 * received: its incident data is then stale with no time to name, so the
 * page never says "No incidents reported." for them.
 */
export function parseProductDetail(raw: unknown): ProductDetail | null {
  if (!isRec(raw)) return null;
  const product = toProduct(raw);
  if (!product) return null;
  return {
    ...product,
    freshness: allReadable(raw.incidents)
      ? product.freshness
      : incidentsNotReceived(product.freshness),
    regionDetails: records(raw.region_details).map(toRegionDetail).filter(nonNull),
    incidents: parseIncidents(raw.incidents),
  };
}

function toListProduct(r: Rec): IncidentListProduct | null {
  const id = str(r.id);
  if (id === "") return null;
  const checkedAt = toDate(r.checked_at);
  return {
    id,
    name: str(r.name, id),
    coveredFrom: toDate(r.covered_from),
    // Fails closed, as toFreshness does: current only when the API says so
    // and its time could be read.
    freshness: {
      checkedAt: { incidents: checkedAt },
      stale: { incidents: checkedAt === null || r.stale !== false },
    },
  };
}

/**
 * The incident list. A product whose incidents cannot all be read counts as
 * not received (no coverage, stale with no time), so the page never calls a
 * month quiet over a record it could not read.
 */
export function parseIncidentList(raw: unknown): IncidentList {
  const r = isRec(raw) ? raw : {};
  const unreadable = new Set(
    list(r.incidents)
      .filter((x) => !isRec(x) || toIncident(x) === null)
      .map((x) => (isRec(x) ? str(x.product_id) : "")),
  );
  const products = records(r.products)
    .map(toListProduct)
    .filter(nonNull)
    .map((p) =>
      unreadable.has("") || unreadable.has(p.id)
        ? {
            ...p,
            coveredFrom: null,
            freshness: { checkedAt: { incidents: null }, stale: { incidents: true } },
          }
        : p,
    );
  return { products, incidents: parseIncidents(r.incidents) };
}
