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

/**
 * How one day of history is painted, for the strip cells and the legend.
 *
 * A day with incidents fills the cell in its status colour. Healthy and
 * no-data days are drawn at 60% height, so a problem day stands out by its
 * shape as well as its colour (WCAG 1.4.1); "No data" is also hatched.
 *
 * Forced colors (Windows High Contrast) replace background colours with the
 * page colour and drop gradients, which erased the strip. There the cells opt
 * out of the override and use system colours instead: a problem day in full
 * CanvasText, a healthy day in solid GrayText, a no-data day hatched.
 */
export function dayFill(status: Status) {
  if (isProblem(status)) {
    return {
      bgcolor: statusVar(status, "fill"),
      [FORCED_COLORS]: { forcedColorAdjust: "none", backgroundColor: "CanvasText" },
    };
  }
  const fill = statusVar(status, "fill");
  const tint = statusVar(status, "tint");
  const unknown = status === "unknown";
  return {
    backgroundImage: unknown ? `${HATCH(fill)}, ${SOLID(tint)}` : SOLID(fill),
    backgroundSize: "100% 60%",
    backgroundPosition: "bottom",
    backgroundRepeat: "no-repeat",
    [FORCED_COLORS]: {
      forcedColorAdjust: "none",
      backgroundImage: unknown ? HATCH("GrayText") : SOLID("GrayText"),
    },
  };
}

/** Focus ring that survives forced colors, where the cell opts out of the override. */
export const dayFocusSx = {
  "&:focus-visible": { outline: "2px solid var(--cs-focus)", outlineOffset: "1px" },
  [FORCED_COLORS]: { "&:focus-visible": { outlineColor: "Highlight" } },
} as const;
