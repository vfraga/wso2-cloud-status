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

import { Stack, Typography } from "@wso2/oxygen-ui";
import type { Uptime } from "../api/types";
import { UPTIME_LABEL } from "../lib/status";

/**
 * Truncates to three decimals, never rounds, so 99.9996 reads "99.999%" and
 * only a value of 100 or more reads "100%". Works on the shortest decimal
 * string, which avoids binary floating point surprises such as
 * Math.floor(99.994 * 1000) = 99993.
 *
 * The upstream sources already round to three decimals (CSM uses
 * JavaScript's toFixed(3)), so a true 99.9996 arrives as 100 and reads
 * "100%". This function guarantees only that we never round up further.
 */
export function formatPercent(percent: number): string {
  if (Number.isNaN(percent) || percent <= 0) return "0%";
  if (percent >= 100) return "100%";
  const text = String(percent);
  const decimal = text.includes("e") ? percent.toFixed(20) : text;
  const [whole = "0", fraction = ""] = decimal.split(".");
  let digits = fraction.slice(0, 3);
  while (digits.endsWith("0")) digits = digits.slice(0, -1);
  const suffix = digits === "" ? "" : "." + digits;
  return whole + suffix + "%";
}

/** "7 days" for "7d", "12 months" for "12mo", for a screen reader; anything else as sent. */
export function windowName(code: string): string {
  const match = /^(\d+)(d|mo)$/.exec(code);
  if (match === null) return code;
  const n = Number(match[1]);
  return `${String(n)} ${match[2] === "d" ? "day" : "month"}${n === 1 ? "" : "s"}`;
}

/**
 * "Uptime  7d 100%  30d 100%" with the figures as a description list. What
 * the figures count is said once, under the product's Regions (UPTIME_NOTE):
 * a 100% next to "Degraded performance" is not a contradiction.
 */
export function UptimeList({
  uptime,
  label,
}: {
  uptime: readonly Uptime[];
  /** Accessible name of the list. */
  label: string;
}) {
  if (uptime.length === 0) return null;
  // The group carries the name: a name on the dl itself is not read.
  return (
    <Stack
      role="group"
      aria-label={label}
      direction="row"
      useFlexGap
      sx={{ flexWrap: "wrap", alignItems: "baseline", columnGap: 2, rowGap: 0.25 }}
    >
      <Typography variant="caption" aria-hidden="true" sx={{ color: "var(--cs-muted)" }}>
        {UPTIME_LABEL}
      </Typography>
      <Stack
        component="dl"
        direction="row"
        useFlexGap
        sx={{ m: 0, flexWrap: "wrap", columnGap: 2, rowGap: 0.25 }}
      >
        {uptime.map((u) => (
          <Stack key={u.window} direction="row" spacing={0.75} sx={{ alignItems: "baseline" }}>
            <Typography component="dt" variant="caption" sx={{ color: "var(--cs-muted)" }}>
              <span aria-hidden="true">{u.window}</span>
              <span className="cs-visually-hidden">{windowName(u.window)}</span>
            </Typography>
            <Typography component="dd" variant="body2" sx={{ m: 0, fontWeight: 600 }}>
              {formatPercent(u.percent)}
            </Typography>
          </Stack>
        ))}
      </Stack>
    </Stack>
  );
}
