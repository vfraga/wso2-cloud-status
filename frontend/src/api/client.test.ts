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

import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { fetchSnapshot } from "./client";
import { ApiError } from "./errors";

const server = setupServer();
beforeAll(() => {
  server.listen({ onUnhandledFrame: "error" });
});
afterEach(() => {
  server.resetHandlers();
});
afterAll(() => {
  server.close();
});

const parse = (raw: unknown): unknown => raw;

describe("fetchSnapshot", () => {
  it("returns the parsed body", async () => {
    server.use(
      http.get("http://api.test/x", ({ request }) => {
        expect(request.headers.get("accept")).toBe("application/json");
        return HttpResponse.json({ a: 1 });
      }),
    );
    const snap = await fetchSnapshot("/x", parse, new AbortController().signal);
    expect(snap).toEqual({ data: { a: 1 }, generatedAt: null, serverNow: null });
  });

  it("reads the body's generated_at, the snapshot's age, whatever the body's shape", async () => {
    const read = async (body: unknown) => {
      server.use(http.get("http://api.test/x", () => HttpResponse.json(body as object)));
      return (await fetchSnapshot("/x", parse, new AbortController().signal)).generatedAt;
    };
    expect((await read({ generated_at: "2026-10-21T14:05:00Z" }))?.toISOString()).toBe(
      "2026-10-21T14:05:00.000Z",
    );
    expect(await read({ generated_at: "later" })).toBeNull();
    expect(await read({ generated_at: 1 })).toBeNull();
    expect(await read({})).toBeNull();
    expect(await read([1])).toBeNull();
    expect(await read(null)).toBeNull();
  });

  it("reads the server's clock from Date, plus Age when a cache held the response", async () => {
    const date = "Tue, 20 Oct 2026 08:00:00 GMT";
    const read = async (headers: Record<string, string>) => {
      server.use(http.get("http://api.test/x", () => HttpResponse.json({}, { headers })));
      return (await fetchSnapshot("/x", parse, new AbortController().signal)).serverNow;
    };
    expect((await read({ Date: date }))?.toISOString()).toBe("2026-10-20T08:00:00.000Z");
    expect((await read({ Date: date, Age: "120" }))?.toISOString()).toBe(
      "2026-10-20T08:02:00.000Z",
    );
    // An Age that is not delta-seconds is ignored.
    expect((await read({ Date: date, Age: "-5" }))?.toISOString()).toBe("2026-10-20T08:00:00.000Z");
    // Without a readable Date the client clock is used.
    expect(await read({})).toBeNull();
    expect(await read({ Date: "soon", Age: "60" })).toBeNull();
  });

  it("rejects on an error status, a non-JSON body and a network failure", async () => {
    server.use(http.get("http://api.test/x", () => new HttpResponse(null, { status: 503 })));
    await expect(fetchSnapshot("/x", parse, new AbortController().signal)).rejects.toMatchObject({
      httpStatus: 503,
    });
    server.use(http.get("http://api.test/x", () => new HttpResponse("<html>", { status: 200 })));
    await expect(fetchSnapshot("/x", parse, new AbortController().signal)).rejects.toBeInstanceOf(
      ApiError,
    );
    server.use(http.get("http://api.test/x", () => HttpResponse.error()));
    await expect(fetchSnapshot("/x", parse, new AbortController().signal)).rejects.toThrow(
      /could not be reached/,
    );
  });

  it("rethrows an abort as is", async () => {
    server.use(http.get("http://api.test/x", () => HttpResponse.json({})));
    const controller = new AbortController();
    controller.abort();
    await expect(fetchSnapshot("/x", parse, controller.signal)).rejects.not.toBeInstanceOf(
      ApiError,
    );
  });
});
