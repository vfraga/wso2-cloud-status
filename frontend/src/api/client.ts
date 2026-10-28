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

import { config } from "../config";
import { ApiError } from "./errors";
import { toDate } from "./parse";
import type { Snapshot } from "./types";

function readDate(headers: Headers, name: string): Date | null {
  const raw = headers.get(name);
  if (raw === null) return null;
  const date = new Date(raw);
  return Number.isNaN(date.getTime()) ? null : date;
}

/**
 * The server's clock when the response was sent: Date plus Age, the seconds
 * a cache held it. Null when Date is missing or unreadable (a cross-origin
 * response without the header exposed, or a static fallback); the client
 * clock is used then. A cached copy without Age carries the origin's Date,
 * so the time it sat in the cache is not counted.
 */
function readServerNow(headers: Headers): Date | null {
  const date = readDate(headers, "Date");
  if (date === null) return null;
  const age = headers.get("Age")?.trim() ?? "";
  const seconds = /^\d+$/.test(age) ? Number(age) : 0;
  return new Date(date.getTime() + seconds * 1000);
}

/** The body's generated_at, the age of the whole snapshot; null when absent or unreadable. */
function readGeneratedAt(body: unknown): Date | null {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return null;
  return toDate((body as { generated_at?: unknown }).generated_at);
}

/**
 * GET a JSON document. `cache: "no-cache"` makes the browser revalidate with
 * the stored ETag, so an unchanged body costs a 304 and no payload.
 */
export async function fetchSnapshot<T>(
  path: string,
  parse: (raw: unknown) => T,
  signal: AbortSignal,
): Promise<Snapshot<T>> {
  let response: Response;
  try {
    response = await fetch(`${config.apiBaseUrl}${path}`, {
      cache: "no-cache",
      signal,
      headers: { Accept: "application/json" },
    });
  } catch (cause) {
    if (signal.aborted) throw cause;
    throw new ApiError("The status API could not be reached");
  }
  if (!response.ok) {
    throw new ApiError(`The status API answered ${String(response.status)}`, response.status);
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new ApiError("The status API sent a response that is not JSON", response.status);
  }
  return {
    data: parse(body),
    generatedAt: readGeneratedAt(body),
    serverNow: readServerNow(response.headers),
  };
}
