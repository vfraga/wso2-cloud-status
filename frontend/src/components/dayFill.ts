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

/** Height of a day's mark by severity, so impacts differ by shape as well as colour. */
const HEIGHT: Record<Status, string> = {
  outage: "100%",
  degraded: "85%",
  maintenance: "70%",
  operational: "60%",
  unknown: "60%",
};

/**
 * How one day of history is painted, for the strip cells and the legend.
 *
 * Each day is a bar in its status colour, as tall as its impact is severe:
 * an outage fills the cell, degraded 85%, maintenance 70%, and healthy and
 * no-data days 60%. So a problem day, and which problem, shows by shape as
 * well as colour (WCAG 1.4.1); "No data" is also hatched.
 *
 * Forced colors (Windows High Contrast) replace background colours with the
 * page colour and drop gradients, which erased the strip. There the cells opt
 * out of the override and use system colours instead, at the same heights: a
 * problem day in CanvasText, a healthy day in GrayText, a no-data day hatched.
 */
export function dayFill(status: Status) {
  const fill = statusVar(status, "fill");
  const tint = statusVar(status, "tint");
  const unknown = status === "unknown";
  const system = isProblem(status) ? "CanvasText" : "GrayText";
  return {
    backgroundImage: unknown ? `${HATCH(fill)}, ${SOLID(tint)}` : SOLID(fill),
    backgroundSize: `100% ${HEIGHT[status]}`,
    backgroundPosition: "bottom",
    backgroundRepeat: "no-repeat",
    [FORCED_COLORS]: {
      forcedColorAdjust: "none",
      backgroundImage: unknown ? HATCH(system) : SOLID(system),
    },
  };
}

/** Focus ring that survives forced colors, where the cell opts out of the override. */
export const dayFocusSx = {
  "&:focus-visible": { outline: "2px solid var(--cs-focus)", outlineOffset: "1px" },
  [FORCED_COLORS]: { "&:focus-visible": { outlineColor: "Highlight" } },
} as const;
