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

import { act, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PageNowProvider, useBannerNow, usePageNow } from "./useNow";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

/** Records every value a reader renders with. */
function readers() {
  const page: Date[] = [];
  const banner: Date[] = [];
  function PageReader() {
    page.push(usePageNow());
    return null;
  }
  function BannerReader() {
    banner.push(useBannerNow());
    return null;
  }
  return { page, banner, PageReader, BannerReader };
}

describe("the page clock", () => {
  it("runs one interval for a page, however many parts read it", () => {
    const spy = vi.spyOn(globalThis, "setInterval");
    const { PageReader, BannerReader } = readers();
    render(
      <PageNowProvider skewMs={0}>
        <PageReader />
        <PageReader />
        <PageReader />
        <BannerReader />
      </PageNowProvider>,
    );
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("ticks every 5 s for the banner and every 30 s, corrected by the skew, for the rest", () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
    vi.setSystemTime(new Date("2026-10-21T14:00:00Z"));
    const { page, banner, PageReader, BannerReader } = readers();
    render(
      <PageNowProvider skewMs={60_000}>
        <PageReader />
        <BannerReader />
      </PageNowProvider>,
    );
    const tick = (): void => {
      act(() => {
        vi.advanceTimersByTime(5_000);
      });
    };
    for (let i = 0; i < 5; i += 1) tick();
    // The banner saw every 5 s tick on this browser's clock; the page did not re-render.
    expect(banner.map((d) => d.toISOString().slice(11, 19))).toEqual([
      "14:00:00",
      "14:00:05",
      "14:00:10",
      "14:00:15",
      "14:00:20",
      "14:00:25",
    ]);
    expect(page.map((d) => d.toISOString().slice(11, 19))).toEqual(["13:59:00"]);
    tick();
    expect(page.at(-1)?.toISOString().slice(11, 19)).toBe("13:59:30");
  });

  it("gives each reader its own clock outside a page", () => {
    const spy = vi.spyOn(globalThis, "setInterval");
    const { PageReader, BannerReader } = readers();
    render(
      <>
        <PageReader />
        <BannerReader />
      </>,
    );
    expect(spy).toHaveBeenCalledTimes(2);
  });
});
