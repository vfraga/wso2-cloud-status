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
import { isProblem } from "../lib/status";
import { statusVar } from "../theme/tokens";

const FORCED_COLORS = "@media (forced-colors: active)";
const HATCH = (colour: string): string =>
  `repeating-linear-gradient(45deg, ${colour} 0 1.5px, transparent 1.5px 4px)`;
const SOLID = (colour: string): string => `linear-gradient(${colour}, ${colour})`;

/** A problem day fills its cell; a quiet or no-data day stands at 60% of it. */
export function dayHeight(status: Status): string {
  return isProblem(status) ? "100%" : "60%";
}

/**
 * How one day of history is painted, for the strip cells and the legend: a
 * bar in its status colour, rounded at both ends, standing on the bottom of
 * its cell. A problem day fills the cell; healthy and no-data days are drawn
 * at 60% height, so a problem day stands out by its shape as well as its
 * colour (WCAG 1.4.1); "No data" is also hatched. The bar is its own box, so
 * a short one keeps its rounded top; the cell stays full height for pointing
 * and focus. `full` draws every status at full height: a legend's marks are
 * one size, told apart by colour and name.
 *
 * Forced colors (Windows High Contrast) replace background colours with the
 * page colour and drop gradients, which erased the strip. There the bars opt
 * out of the override and use system colours instead: a problem day in
 * CanvasText, a healthy day in GrayText, a no-data day hatched.
 */
export function dayFill(status: Status, { full = false }: { full?: boolean } = {}) {
  const fill = statusVar(status, "fill");
  const tint = statusVar(status, "tint");
  const unknown = status === "unknown";
  const system = isProblem(status) ? "CanvasText" : "GrayText";
  return {
    position: "relative",
    "&::before": {
      content: '""',
      position: "absolute",
      left: 0,
      right: 0,
      bottom: 0,
      height: full ? "100%" : dayHeight(status),
      borderRadius: "inherit",
      backgroundImage: unknown ? `${HATCH(fill)}, ${SOLID(tint)}` : SOLID(fill),
      [FORCED_COLORS]: {
        forcedColorAdjust: "none",
        backgroundImage: unknown ? HATCH(system) : SOLID(system),
      },
    },
  } as const;
}

export const dayFocusSx = {
  "&:focus-visible": { outline: "2px solid var(--cs-focus)", outlineOffset: "1px" },
  [FORCED_COLORS]: { "&:focus-visible": { outlineColor: "Highlight" } },
} as const;
