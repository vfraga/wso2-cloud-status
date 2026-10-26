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

export function trimTrailingSlashes(value: string): string {
  let end = value.length;
  while (end > 0 && value.charAt(end - 1) === "/") end -= 1;
  return value.slice(0, end);
}

/** Runtime settings. Intervals are in milliseconds. */
export const config = {
  apiBaseUrl: trimTrailingSlashes(import.meta.env.VITE_API_BASE_URL ?? ""),
  summaryIntervalMs: 30_000,
  productIntervalMs: 30_000,
  maxBackoffMs: 120_000,
  /** A request that has not answered by then is aborted and counts as a failure. */
  requestTimeoutMs: 15_000,
  staleAfterMs: 5 * 60_000,
} as const;
