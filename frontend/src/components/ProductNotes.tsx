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
import { Clock } from "@wso2/oxygen-ui-icons-react";
import type { ProductSummary } from "../api/types";
import { usePageNow } from "../hooks/useNow";
import { staleFeedLines, type PartlyShown } from "../lib/dataNotes";
import { DataNote } from "./DataNote";

/**
 * The lines under a product's status when its incident or uptime data could
 * not be refreshed: "Incidents last updated 2:05 PM UTC (12 min ago)", per
 * stale feed. They show at any status and do not open the regions: the
 * values shown are the last known ones.
 */
export function ProductNotes({
  product,
  partly,
  uptime = true,
  alignEnd = false,
}: {
  product: ProductSummary;
  /** Whether other sources' data is shown for a feed that never answered (see staleFeedLines). */
  partly?: PartlyShown;
  /** False where no uptime is shown, so no line speaks of it. */
  uptime?: boolean;
  alignEnd?: boolean;
}) {
  const now = usePageNow();
  const lines = staleFeedLines(product, now, partly, uptime);
  if (lines.length === 0) return null;
  return (
    <Stack spacing={0.25}>
      {lines.map((line) => (
        <DataNote key={line} icon={<Clock aria-hidden="true" size={14} />} alignEnd={alignEnd}>
          {line}
        </DataNote>
      ))}
    </Stack>
  );
}
