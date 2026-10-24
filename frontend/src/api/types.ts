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

/** Shapes of the status API (api/openapi.yaml), after defensive parsing. */

export const STATUSES = ["unknown", "operational", "maintenance", "degraded", "outage"] as const;
export type Status = (typeof STATUSES)[number];

export interface Uptime {
  window: string;
  percent: number;
}

export interface Component {
  name: string;
  description?: string;
  status: Status;
  message?: string;
  uptime: Uptime[];
}

export interface Group {
  name: string;
  status: Status;
  components: Component[];
}

/** A place a product runs in, such as US, whose regions are its parts. */
export interface Location {
  id: string;
  name: string;
  status: Status;
}

export interface RegionSummary {
  id: string;
  name: string;
  status: Status;
  pageUrl: string;
  uptime: Uptime[];
  /** The id of the location the region is part of, if any. */
  location?: string;
}

export interface RegionDetail extends RegionSummary {
  groups: Group[];
}

export interface Day {
  date: string;
  status: Status;
  minutes: Partial<Record<Status, number>>;
  incidentIds: string[];
}

export interface Incident {
  id: string;
  productId: string;
  title: string;
  impact: Status;
  state: string;
  startedAt: Date;
  resolvedAt: Date | null;
}

/** One time per kind of upstream data a product has. */
export interface PerKind<T> {
  components: T;
  incidents: T;
  uptime: T;
}

/** What the API says about how current a product's data is. */
export interface ProductFreshness {
  /**
   * The oldest last successful fetch of each kind among the product's
   * sources, a server-clock time floored to the minute; null while one of
   * them has never answered for that kind.
   */
  checkedAt: PerKind<Date | null>;
  /** True for a kind past its staleness or never answered. */
  stale: PerKind<boolean>;
}

export interface ProductSummary {
  id: string;
  name: string;
  description?: string;
  pageUrl: string;
  status: Status;
  /** False when any region or component status is unknown. */
  dataComplete: boolean;
  /** How current each kind of its data is; every kind is stale when the API does not say. */
  freshness: ProductFreshness;
  /** Empty when the regions are places themselves. */
  locations: Location[];
  regions: RegionSummary[];
  history: Day[];
}

export interface ProductDetail extends ProductSummary {
  regionDetails: RegionDetail[];
  incidents: Incident[];
}

export interface Summary {
  status: Status;
  /** False when any product has incomplete data or an unknown status. */
  dataComplete: boolean;
  products: ProductSummary[];
  activeIncidents: Incident[];
}

/** A parsed payload plus the freshness the server reported. */
export interface Snapshot<T> {
  data: T;
  /**
   * The body's generated_at: when the service built the snapshot, a
   * server-clock time floored to the minute. Null when absent or unreadable.
   */
  generatedAt: Date | null;
  /** The server's clock when it sent the response (Date plus Age), when readable. */
  serverNow: Date | null;
}
