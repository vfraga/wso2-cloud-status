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

import { useEffect, useRef, useState } from "react";
import { fetchSnapshot } from "../api/client";
import { ApiError } from "../api/errors";
import type { Snapshot } from "../api/types";
import { config } from "../config";
import { clockSkew, freshness, staleOnArrival } from "../lib/freshness";
import { useBannerNow } from "./useNow";

export interface PolledState<T> {
  data: T | null;
  /** The body's generated_at: when the service built the snapshot (server clock). */
  generatedAt: Date | null;
  /** When this browser last received a valid response. */
  lastSuccessAt: Date | null;
  /** True when the most recent attempt failed. */
  failed: boolean;
  /** True when the most recent attempt answered 404. */
  notFound: boolean;
  /** True when the last valid response's generated_at was already older than config.staleAfterMs on arrival. */
  staleOnArrival: boolean;
  /** This browser's clock minus the server's, from the last valid response. */
  skewMs: number;
}

const initial = {
  data: null,
  generatedAt: null,
  lastSuccessAt: null,
  failed: false,
  notFound: false,
  staleOnArrival: false,
  skewMs: 0,
} as const;

/** Delay before the next attempt: the interval, doubled per consecutive failure, capped. */
export function nextDelay(
  intervalMs: number,
  failures: number,
  maxMs = config.maxBackoffMs,
): number {
  if (failures <= 0) return intervalMs;
  return Math.min(intervalMs * 2 ** failures, maxMs);
}

/**
 * The server's clock for this session, anchored at the response with the
 * newest server time (Date plus Age) seen on any path. The server's clock
 * only moves forward, so a response whose server time is not newer is a
 * copy made earlier, such as a CDN copy served without Age, and is judged on
 * the anchor's clock: its age shows instead of reading as fresh.
 */
let anchor: { serverMs: number; skewMs: number } | null = null;

/** This browser's clock minus the server's, from the newest server time seen. */
function sessionSkew(receivedAt: Date, serverNow: Date | null): number {
  if (serverNow !== null && (anchor === null || serverNow.getTime() > anchor.serverMs)) {
    anchor = { serverMs: serverNow.getTime(), skewMs: clockSkew(receivedAt, serverNow) };
  }
  return anchor?.skewMs ?? 0;
}

/** The last state per API path, so a view that mounts again starts from what was shown. */
const lastStates = new Map<string, PolledState<unknown>>();

/** Forgets the server clock and the last states; for tests, which share one module. */
export function forgetPolledState(): void {
  anchor = null;
  lastStates.clear();
}

/**
 * State after a valid response. A body built before the one shown (a
 * replica a poll behind, an older CDN copy) never replaces it: the page
 * keeps the newer data, and the answer counts as a successful contact.
 */
function received<T>(
  prev: PolledState<T>,
  snapshot: Snapshot<T>,
  receivedAt: Date,
  skewMs: number,
): PolledState<T> {
  const contact = {
    lastSuccessAt: receivedAt,
    failed: false,
    notFound: false,
    staleOnArrival: staleOnArrival(new Date(receivedAt.getTime() - skewMs), snapshot.generatedAt),
    skewMs,
  };
  const older =
    prev.data !== null &&
    prev.generatedAt !== null &&
    snapshot.generatedAt !== null &&
    snapshot.generatedAt.getTime() < prev.generatedAt.getTime();
  if (older) return { ...prev, ...contact };
  return { data: snapshot.data, generatedAt: snapshot.generatedAt, ...contact };
}

interface Deadline {
  /**
   * True when something other than the deadline aborted the request: hiding the
   * tab, a newer poll or unmounting. Those stay quiet; a timeout is a failure.
   */
  abortedQuietly: () => boolean;
  clear: () => void;
}

/**
 * Aborts `controller` after `ms`. AbortSignal.any and AbortSignal.timeout would
 * do this, but AbortSignal.any is newer than the build's browser targets.
 */
function deadline(controller: AbortController, ms: number): Deadline {
  let fired = false;
  const id = setTimeout(() => {
    fired = true;
    controller.abort(new ApiError("The status API did not answer in time"));
  }, ms);
  return {
    abortedQuietly: () => controller.signal.aborted && !fired,
    clear: () => {
      clearTimeout(id);
    },
  };
}

/**
 * Polls one API path. Pauses while the tab is hidden, refreshes as soon as it
 * is visible again, and backs off exponentially while the API is failing. A
 * request that does not answer within config.requestTimeoutMs fails like any
 * other error. `parse` must be a stable function. A `refreshKey` that changes
 * once it is known (not null) asks for a fresh answer at once, so a resource
 * can follow another.
 */
export function usePolled<T>(
  path: string,
  parse: (raw: unknown) => T,
  intervalMs: number,
  refreshKey: string | null = null,
): PolledState<T> {
  const [state, setState] = useState<PolledState<T>>(
    () => (lastStates.get(path) as PolledState<T> | undefined) ?? initial,
  );
  useEffect(() => {
    if (state.lastSuccessAt !== null) lastStates.set(path, state);
  }, [path, state]);

  const pollNow = useRef<() => void>(() => undefined);
  const lastKey = useRef(refreshKey);
  useEffect(() => {
    const previous = lastKey.current;
    lastKey.current = refreshKey;
    if (previous !== null && refreshKey !== null && previous !== refreshKey) pollNow.current();
  }, [refreshKey]);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let controller: AbortController | undefined;
    let failures = 0;
    const life = { active: true };
    const isActive = (): boolean => life.active;

    const schedule = (delay: number): void => {
      clearTimeout(timer);
      timer = setTimeout(() => void poll(), delay);
    };

    const poll = async (): Promise<void> => {
      clearTimeout(timer);
      controller?.abort();
      const current = new AbortController();
      controller = current;
      const limit = deadline(current, config.requestTimeoutMs);
      try {
        const snapshot = await fetchSnapshot(path, parse, current.signal);
        if (!isActive() || current.signal.aborted) return;
        failures = 0;
        const at = new Date();
        const skewMs = sessionSkew(at, snapshot.serverNow);
        setState((prev) => received(prev, snapshot, at, skewMs));
      } catch (error) {
        if (!isActive() || limit.abortedQuietly()) return;
        failures += 1;
        const notFound = error instanceof ApiError && error.httpStatus === 404;
        setState((prev) => ({ ...prev, failed: true, notFound }));
      } finally {
        limit.clear();
      }
      if (isActive() && !document.hidden) schedule(nextDelay(intervalMs, failures));
    };

    const onVisibility = (): void => {
      if (document.hidden) {
        clearTimeout(timer);
        controller?.abort();
      } else {
        void poll();
      }
    };

    document.addEventListener("visibilitychange", onVisibility);
    pollNow.current = () => {
      if (isActive() && !document.hidden) void poll();
    };
    if (!document.hidden) void poll();

    return () => {
      life.active = false;
      clearTimeout(timer);
      controller?.abort();
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [path, parse, intervalMs]);

  return state;
}

/**
 * While the page cannot vouch for a resource's data (the banner reads "Status
 * unavailable": refreshes have failed for longer than the limit, or the copy
 * received was already old), when that data was built: its generated_at, a
 * server-clock time. Nothing shown from it may run past that time: ongoing
 * durations stop there and later days are not vouched for. Null while the
 * data is current.
 */
export function useKnownUntil(state: PolledState<unknown>): Date | null {
  const now = useBannerNow();
  const { unavailable } = freshness(now, {
    checkedAt: null,
    lastSuccessAt: state.lastSuccessAt,
    failed: state.failed,
    servedStale: state.staleOnArrival,
    skewMs: state.skewMs,
  });
  if (!unavailable) return null;
  if (state.generatedAt !== null) return state.generatedAt;
  return state.lastSuccessAt === null
    ? null
    : new Date(state.lastSuccessAt.getTime() - state.skewMs);
}
