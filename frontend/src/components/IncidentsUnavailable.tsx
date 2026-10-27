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

import { Stack } from "@wso2/oxygen-ui";
import { CircleHelp } from "@wso2/oxygen-ui-icons-react";
import type { MissingIncidents } from "../lib/dataNotes";
import {
  incidentInfoIncompleteAfter,
  incidentInfoPartlyUnavailable,
  incidentInfoUnavailable,
} from "../lib/status";
import { formatUtcDateTime } from "../lib/time";
import { DataNote } from "./DataNote";

function text({ product, coverage, partly }: MissingIncidents): string {
  if (coverage.state === "until") {
    return incidentInfoIncompleteAfter(product.name, formatUtcDateTime(coverage.at));
  }
  return partly
    ? incidentInfoPartlyUnavailable(product.name)
    : incidentInfoUnavailable(product.name);
}

/**
 * One line per product whose incident data is unavailable or incomplete:
 * "Incident information for Moesif is incomplete after Oct 21, 2026, 2:05 PM
 * UTC."
 */
export function IncidentsUnavailable({ missing }: { missing: readonly MissingIncidents[] }) {
  if (missing.length === 0) return null;
  return (
    <Stack spacing={0.75} sx={{ mt: 2 }}>
      {missing.map((m) => (
        <DataNote key={m.product.id} icon={<CircleHelp aria-hidden="true" size={14} />}>
          {text(m)}
        </DataNote>
      ))}
    </Stack>
  );
}
