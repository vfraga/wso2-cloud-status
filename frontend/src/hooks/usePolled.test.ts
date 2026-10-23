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

import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { nextDelay, usePolled } from "./usePolled";

function respond(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers });
}

function setHidden(hidden: boolean): void {
  Object.defineProperty(document, "hidden", { configurable: true, get: () => hidden });
  document.dispatchEvent(new Event("visibilitychange"));
}

const parse = (raw: unknown): unknown => raw;

describe("nextDelay", () => {
  it("doubles per failure and caps at two minutes", () => {
    expect(nextDelay(30_000, 0)).toBe(30_000);
    expect(nextDelay(30_000, 1)).toBe(60_000);
    expect(nextDelay(30_000, 2)).toBe(120_000);
    expect(nextDelay(30_000, 9)).toBe(120_000);
  });
});

describe("usePolled", () => {
  const fetchMock = vi.fn<typeof fetch>();

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    vi.stubGlobal("fetch", fetchMock);
    fetchMock.mockReset();
    setHidden(false);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("revalidates with no-cache and polls on the interval", async () => {
    fetchMock.mockImplementation(() => Promise.resolve(respond({ n: 1 })));
    const { result } = renderHook(() => usePolled("/p", parse, 30_000));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(result.current.data).toEqual({ n: 1 });
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({ cache: "no-cache" });
    expect(fetchMock.mock.calls[0]?.[0]).toBe("http://api.test/p");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("backs off while failing, keeps the last data and recovers", async () => {
    fetchMock.mockImplementationOnce(() => Promise.resolve(respond({ n: 1 })));
    fetchMock.mockImplementation(() => Promise.resolve(respond({}, 500)));
    const { result } = renderHook(() => usePolled("/p", parse, 30_000));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    expect(result.current).toMatchObject({ failed: true, data: { n: 1 } });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    // Next attempt waits 60 s, not 30 s.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    fetchMock.mockImplementation(() => Promise.resolve(respond({ n: 2 })));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    expect(result.current).toMatchObject({ failed: false, data: { n: 2 } });
  });

  it("times out a request that does not answer, counts it as failed and backs off", async () => {
    fetchMock.mockImplementation(
      (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            reject(init.signal?.reason as Error);
          });
        }),
    );
    const { result } = renderHook(() => usePolled("/p", parse, 30_000));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(14_999);
    });
    expect(result.current.failed).toBe(false);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(result.current).toMatchObject({ failed: true, notFound: false });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    // One failure: the next attempt waits 60 s, not 30 s.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(59_999);
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    fetchMock.mockImplementation(() => Promise.resolve(respond({ n: 1 })));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.current).toMatchObject({ failed: false, data: { n: 1 } });
  });

  it("stays quiet when hiding the tab aborts a pending request", async () => {
    fetchMock.mockImplementation(
      (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            reject(init.signal?.reason as Error);
          });
        }),
    );
    const { result } = renderHook(() => usePolled("/p", parse, 30_000));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });
    await act(async () => {
      setHidden(true);
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(result.current.failed).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("measures staleness on the server's clock and keeps the skew", async () => {
    // The server's clock is 10 minutes behind this browser's; its data is 30 s old.
    const behind = (msAgo: number) => new Date(Date.now() - 10 * 60_000 - msAgo);
    fetchMock.mockImplementation(() =>
      Promise.resolve(
        respond({ n: 1, generated_at: behind(30_000).toISOString() }, 200, {
          Date: behind(0).toUTCString(),
        }),
      ),
    );
    const { result } = renderHook(() => usePolled("/p", parse, 30_000));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(result.current.staleOnArrival).toBe(false);
    // Date has whole seconds, so the skew is within a second of 10 minutes.
    expect(result.current.skewMs).toBeGreaterThanOrEqual(10 * 60_000);
    expect(result.current.skewMs).toBeLessThan(10 * 60_000 + 1_000);
  });

  it("never replaces the data shown with a body built before it", async () => {
    const at = (msAgo: number) => new Date(Date.now() - msAgo).toISOString();
    fetchMock.mockImplementationOnce(() => Promise.resolve(respond({ n: 2, generated_at: at(0) })));
    // A replica a poll behind, or an older copy at another edge site.
    fetchMock.mockImplementation(() =>
      Promise.resolve(respond({ n: 1, generated_at: at(60_000) })),
    );
    const { result } = renderHook(() => usePolled("/p", parse, 30_000));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    const first = result.current.lastSuccessAt;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    expect(result.current).toMatchObject({ data: { n: 2 }, failed: false });
    // The answer still counts as a successful contact.
    expect(result.current.lastSuccessAt?.getTime()).toBeGreaterThan(first?.getTime() ?? 0);
  });

  it("judges a copy made before the newest server time seen as old, even without Age", async () => {
    const generated = new Date(Date.now()).toISOString();
    fetchMock.mockImplementationOnce(() =>
      Promise.resolve(
        respond({ n: 1, generated_at: generated }, 200, { Date: new Date().toUTCString() }),
      ),
    );
    // Then the edge serves a copy made 21 minutes ago, with its original Date and no Age.
    const old = new Date(Date.now() - 21 * 60_000);
    fetchMock.mockImplementation(() =>
      Promise.resolve(
        respond({ n: 0, generated_at: old.toISOString() }, 200, { Date: old.toUTCString() }),
      ),
    );
    const { result } = renderHook(() => usePolled("/p", parse, 30_000));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(result.current.staleOnArrival).toBe(false);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    // On its own Date the copy would read 0 s old; on the session's server clock it is 21 min old.
    expect(result.current).toMatchObject({ staleOnArrival: true, data: { n: 1 } });
  });

  it("starts a view that mounts again from the last state of its path", async () => {
    fetchMock.mockImplementation(() => Promise.resolve(respond({ n: 1 })));
    const first = renderHook(() => usePolled("/p", parse, 30_000));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    first.unmount();
    fetchMock.mockImplementation(() => Promise.resolve(respond({}, 503)));
    const again = renderHook(() => usePolled("/p", parse, 30_000));
    // Before any answer, the last data is on screen, not a first-visit failure.
    expect(again.result.current).toMatchObject({ data: { n: 1 }, failed: false });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(again.result.current).toMatchObject({ data: { n: 1 }, failed: true });
    // Another path starts empty.
    expect(renderHook(() => usePolled("/q", parse, 30_000)).result.current.data).toBeNull();
  });

  it("records whether a response was already older than the limit on arrival", async () => {
    const at = (msAgo: number) => new Date(Date.now() - msAgo).toISOString();
    fetchMock.mockImplementationOnce(() =>
      Promise.resolve(respond({ n: 1, generated_at: at(10 * 60_000) })),
    );
    fetchMock.mockImplementation(() => Promise.resolve(respond({ n: 2, generated_at: at(1_000) })));
    const { result } = renderHook(() => usePolled("/p", parse, 30_000));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(result.current).toMatchObject({ data: { n: 1 }, staleOnArrival: true });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    expect(result.current).toMatchObject({ data: { n: 2 }, staleOnArrival: false });
  });

  it("flags a 404", async () => {
    fetchMock.mockImplementation(() => Promise.resolve(respond({}, 404)));
    const { result } = renderHook(() => usePolled("/p", parse, 30_000));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(result.current).toMatchObject({ notFound: true, failed: true });
  });

  it("pauses while hidden and refreshes at once when visible again", async () => {
    fetchMock.mockImplementation(() => Promise.resolve(respond({ n: 1 })));
    renderHook(() => usePolled("/p", parse, 30_000));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    act(() => {
      setHidden(true);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(120_000);
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await act(async () => {
      setHidden(false);
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does not fetch at all when mounted hidden", async () => {
    setHidden(true);
    fetchMock.mockImplementation(() => Promise.resolve(respond({})));
    renderHook(() => usePolled("/p", parse, 30_000));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
