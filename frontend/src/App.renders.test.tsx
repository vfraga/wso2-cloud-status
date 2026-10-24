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

import { act, render, screen } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import type { ComponentProps } from "react";
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import { App } from "./App";
import { forgetListedProducts } from "./lib/fallbackProducts";
import { summaryBody } from "./test/factories";

// Counts the history strips drawn: each product row draws one.
const strips = vi.hoisted(() => ({ drawn: 0 }));
vi.mock("./components/HistoryStrip", async (importOriginal) => {
  const original = await importOriginal<typeof import("./components/HistoryStrip")>();
  const Counted = (props: ComponentProps<typeof original.HistoryStrip>) => {
    strips.drawn += 1;
    return <original.HistoryStrip {...props} />;
  };
  return { ...original, HistoryStrip: Counted };
});

const server = setupServer();
beforeAll(() => {
  server.listen({ onUnhandledFrame: "error" });
});
afterEach(() => {
  server.resetHandlers();
  vi.useRealTimers();
  forgetListedProducts();
});
afterAll(() => {
  server.close();
});

it("does not redraw the product rows on each tick of the banner's clock", async () => {
  vi.useFakeTimers({
    shouldAdvanceTime: true,
    toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"],
  });
  server.use(
    http.get("http://api.test/api/v1/summary", () => HttpResponse.json(summaryBody())),
    http.get("http://api.test/api/v1/incidents", () => HttpResponse.json({ incidents: [] })),
  );
  render(<App />);
  await screen.findByRole("heading", { name: "Past incidents" });
  await screen.findAllByText(/^No incidents reported/);
  const drawn = strips.drawn;
  expect(drawn).toBeGreaterThan(0);
  // The banner's clock ticks every 5 seconds; the next poll is 30 seconds away.
  await act(async () => {
    await vi.advanceTimersByTimeAsync(12_000);
  });
  expect(strips.drawn).toBe(drawn);
});
