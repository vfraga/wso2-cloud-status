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

import { Box, Stack, Typography } from "@wso2/oxygen-ui";
import type { Status } from "../api/types";
import { LEGEND_INCIDENTS, LEGEND_INTRO, LEGEND_NO_DATA, LEGEND_QUIET } from "../lib/status";
import { dayFill } from "./dayFill";

function Swatch({ status }: { status: Status }) {
  return (
    <Box
      aria-hidden="true"
      sx={{
        display: "inline-block",
        width: 8,
        height: 18,
        borderRadius: "1px",
        flexShrink: 0,
        ...dayFill(status),
      }}
    />
  );
}

function Entry({ statuses, text }: { statuses: readonly Status[]; text: string }) {
  return (
    <Stack component="span" direction="row" useFlexGap sx={{ alignItems: "flex-end", gap: 0.75 }}>
      <Stack component="span" direction="row" useFlexGap sx={{ gap: "2px" }}>
        {statuses.map((s) => (
          <Swatch key={s} status={s} />
        ))}
      </Stack>
      <span>{text}</span>
    </Stack>
  );
}

/**
 * One line under the strips that says what their bars mean, drawn with the
 * same marks, so a grey "No data" day is not read as an outage.
 */
export function HistoryLegend() {
  return (
    <Typography
      component="div"
      variant="caption"
      sx={{
        display: "flex",
        flexWrap: "wrap",
        alignItems: "center",
        columnGap: 2,
        rowGap: 0.5,
        mt: 1.5,
        color: "var(--cs-muted)",
      }}
    >
      <span>{LEGEND_INTRO}</span>
      <Entry statuses={["outage", "degraded", "maintenance"]} text={LEGEND_INCIDENTS} />
      <Entry statuses={["operational"]} text={LEGEND_QUIET} />
      <Entry statuses={["unknown"]} text={LEGEND_NO_DATA} />
    </Typography>
  );
}
