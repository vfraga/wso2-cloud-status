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

import {
  createContext,
  createElement,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";

/** This browser's clock, refreshed every `intervalMs` while `enabled`. */
export function useNow(intervalMs: number, enabled = true): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    if (!enabled) return undefined;
    const id = setInterval(() => {
      setNow(new Date());
    }, intervalMs);
    return () => {
      clearInterval(id);
    };
  }, [intervalMs, enabled]);
  return now;
}

/** How often the page's shared clock ticks: durations are shown to the minute. */
const PAGE_TICK_MS = 30_000;
/** How often the banner's clock ticks, so it turns to "Status unavailable" soon after the limit. */
const BANNER_TICK_MS = 5_000;

const PageNow = createContext<Date | null>(null);
const BannerNow = createContext<Date | null>(null);

/**
 * One interval for the whole page: every BANNER_TICK_MS for the banner, and
 * every PAGE_TICK_MS (the same object in between, so its readers do not
 * re-render) for the rest.
 */
function usePageClock(): { fine: Date; coarse: Date } {
  const [clock, setClock] = useState(() => {
    const t = new Date();
    return { fine: t, coarse: t };
  });
  useEffect(() => {
    const id = setInterval(() => {
      setClock((prev) => {
        const t = new Date();
        // Half a tick of slack, so timer jitter does not skip a coarse tick.
        const due = t.getTime() - prev.coarse.getTime() >= PAGE_TICK_MS - BANNER_TICK_MS / 2;
        return { fine: t, coarse: due ? t : prev.coarse };
      });
    }, BANNER_TICK_MS);
    return () => {
      clearInterval(id);
    };
  }, []);
  return clock;
}

/**
 * One "now" for everything a page shows: incident durations and the strip's
 * "Today". It is this browser's clock
 * corrected by `skewMs` (its clock minus the server's, from the last
 * response), so a visitor's wrong clock changes none of them, and every part
 * of one render uses the same instant. The banner reads the same clock at a
 * finer tick, uncorrected, since it compares this browser's own fetch times.
 */
export function PageNowProvider({ skewMs, children }: { skewMs: number; children: ReactNode }) {
  const { fine, coarse } = usePageClock();
  const now = useMemo(() => new Date(coarse.getTime() - skewMs), [coarse, skewMs]);
  return createElement(
    PageNow.Provider,
    { value: now },
    createElement(BannerNow.Provider, { value: fine }, children),
  );
}

/** The page's shared now (see PageNowProvider); its own ticking clock outside a page. */
export function usePageNow(): Date {
  const shared = useContext(PageNow);
  const own = useNow(PAGE_TICK_MS, shared === null);
  return shared ?? own;
}

/** This browser's clock at the banner's tick: the page's clock, or its own outside a page. */
export function useBannerNow(): Date {
  const shared = useContext(BannerNow);
  const own = useNow(BANNER_TICK_MS, shared === null);
  return shared ?? own;
}
