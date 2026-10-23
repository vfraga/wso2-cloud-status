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

import { useSyncExternalStore } from "react";

/** Viewport widths (px) at which the history strip grows, as on Atlassian Statuspage. */
const MEDIUM_MIN_WIDTH = 600;
const LARGE_MIN_WIDTH = 900;

const MEDIUM = `(min-width: ${String(MEDIUM_MIN_WIDTH)}px)`;
const LARGE = `(min-width: ${String(LARGE_MIN_WIDTH)}px)`;

/** 30 days below 600 px, 60 from 600 to 899 px, 90 from 900 px up. */
export function daysFor(medium: boolean, large: boolean): number {
  if (large) return 90;
  return medium ? 60 : 30;
}

function subscribe(onChange: () => void): () => void {
  const lists = [window.matchMedia(MEDIUM), window.matchMedia(LARGE)];
  for (const list of lists) list.addEventListener("change", onChange);
  return () => {
    for (const list of lists) list.removeEventListener("change", onChange);
  };
}

const snapshot = (): number =>
  daysFor(window.matchMedia(MEDIUM).matches, window.matchMedia(LARGE).matches);

/** How many days of history fit the viewport. */
export function useVisibleDays(): number {
  return useSyncExternalStore(subscribe, snapshot, () => 90);
}
