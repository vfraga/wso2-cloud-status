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

import { Box } from "@wso2/oxygen-ui";
import { createContext, useContext, type ReactNode } from "react";
import type { RegionDetail, Uptime } from "../api/types";

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

/** Days a window code spans, for ordering columns; a code it cannot read sorts last. */
function windowDays(code: string): number {
  const match = /^(\d+)(d|mo)$/.exec(code);
  if (match === null) return Number.POSITIVE_INFINITY;
  return Number(match[1]) * (match[2] === "d" ? 1 : 30);
}

/** Every window the product's regions and components publish, shortest first: its columns. */
export function uptimeColumns(regions: readonly RegionDetail[]): string[] {
  const seen = new Set<string>();
  for (const region of regions) {
    for (const u of region.uptime) seen.add(u.window);
    for (const group of region.groups) {
      for (const component of group.components) {
        for (const u of component.uptime) seen.add(u.window);
      }
    }
  }
  return [...seen].sort((a, b) => windowDays(a) - windowDays(b) || a.localeCompare(b));
}

/** The uptime columns of the product on show, shared by every row of its regions. */
export const UptimeColumns = createContext<readonly string[]>([]);

/** From here, a row puts its figures between its name and status; below, on a line under them. */
export const WIDE = "@media (min-width: 900px)";
/** Each window's column: narrower on a phone, so four fit beside the page's gutters. */
const COLUMN = { narrow: "4.25rem", wide: "4.75rem" } as const;
/** Fits "Degraded performance", the longest status label, with its icon (as on the home page). */
const STATUS_COLUMN = "13rem";

/**
 * One row of the regions list. Its figures sit in columns every row shares,
 * under the window codes its location (or the list) shows once: between the
 * name and the status on a wide screen, on a line under them on a narrow one.
 */
export function GridRow({
  name,
  status,
  figures,
  align = "center",
}: {
  name: ReactNode;
  status: ReactNode;
  figures?: ReactNode;
  /** "start" for rows whose name may run to several lines. */
  align?: "center" | "start";
}) {
  const columns = useContext(UptimeColumns);
  const hasColumns = columns.length > 0;
  const figuresWidth = `calc(${String(columns.length)} * ${COLUMN.wide})`;
  return (
    <Box
      sx={{
        display: "grid",
        gridTemplateColumns: "minmax(0, 1fr) auto",
        gridTemplateAreas: '"name status" "figures figures"',
        alignItems: align,
        columnGap: 2,
        [WIDE]: {
          gridTemplateColumns: hasColumns
            ? `minmax(0, 1fr) ${figuresWidth} ${STATUS_COLUMN}`
            : `minmax(0, 1fr) ${STATUS_COLUMN}`,
          gridTemplateAreas: hasColumns ? '"name figures status"' : '"name status"',
        },
      }}
    >
      <Box sx={{ gridArea: "name", minWidth: 0 }}>{name}</Box>
      <Box sx={{ gridArea: "status", [WIDE]: { pl: 2 } }}>{status}</Box>
      {figures !== undefined && <Box sx={{ gridArea: "figures" }}>{figures}</Box>}
    </Box>
  );
}

/**
 * The product's columns, one per window, with no gap: a gap would push a
 * figure off its code. `marginTop` separates them from the line above on a
 * narrow screen, where they have a line of their own. Complete, so a caller
 * never overrides the wide rules and puts the codes and figures out of step.
 */
const figureGrid = (columns: readonly string[], marginTop: number) => ({
  display: "grid",
  mt: marginTop,
  gridTemplateColumns: `repeat(${String(columns.length)}, ${COLUMN.narrow})`,
  [WIDE]: { mt: 0, gridTemplateColumns: `repeat(${String(columns.length)}, ${COLUMN.wide})` },
});

/** The window codes over the columns; each figure is read aloud with its window instead. */
export function UptimeHeader() {
  const columns = useContext(UptimeColumns);
  if (columns.length === 0) return null;
  return (
    <Box aria-hidden="true" sx={figureGrid(columns, 0.5)}>
      {columns.map((code) => (
        <Box
          key={code}
          component="span"
          sx={{ fontSize: "0.75rem", color: "var(--cs-muted)", textAlign: "right" }}
        >
          {code}
        </Box>
      ))}
    </Box>
  );
}

/**
 * A region's or component's figures as a description list named after it,
 * each in its window's column under the codes above, blank where it has
 * none. A screen reader hears "7 days, 100%".
 */
export function UptimeFigures({
  uptime,
  label,
  strong = true,
}: {
  uptime: readonly Uptime[];
  label: string;
  /** Bold, for a region; a component's figures are set lighter under it. */
  strong?: boolean;
}) {
  const columns = useContext(UptimeColumns);
  if (uptime.length === 0) return null;
  const byWindow = new Map(uptime.map((u) => [u.window, u.percent]));
  // The group names the list; on the dl itself the role would unmake it a list.
  return (
    <Box role="group" aria-label={label}>
      <Box component="dl" sx={{ m: 0, ...figureGrid(columns, 0.25) }}>
        {columns.map((code) => {
          const percent = byWindow.get(code);
          if (percent === undefined) return <Box key={code} aria-hidden="true" />;
          return (
            <Box key={code} sx={{ textAlign: "right" }}>
              <dt className="cs-visually-hidden">{windowName(code)}</dt>
              <Box
                component="dd"
                sx={{
                  m: 0,
                  fontSize: "0.875rem",
                  fontWeight: strong ? 600 : 400,
                  fontVariantNumeric: "tabular-nums",
                }}
              >
                {formatPercent(percent)}
              </Box>
            </Box>
          );
        })}
      </Box>
    </Box>
  );
}
