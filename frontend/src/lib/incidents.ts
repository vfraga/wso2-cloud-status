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
