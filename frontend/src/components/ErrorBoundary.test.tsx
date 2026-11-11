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
import { afterEach, describe, expect, it, vi } from "vitest";
import { ErrorBoundary } from "./ErrorBoundary";

afterEach(() => {
  vi.useRealTimers();
});

describe("ErrorBoundary", () => {
  it("shows a plain message when rendering throws, and the title stops naming a status", () => {
    const Boom = (): never => {
      throw new Error("boom");
    };
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    document.title = "All systems operational - WSO2 Cloud Status";
    render(
      <ErrorBoundary>
        <Boom />
      </ErrorBoundary>,
    );
    expect(screen.getByRole("alert")).toHaveTextContent("Something went wrong");
    // Nothing polls while the boundary shows, so the last status cannot stay in the tab.
    expect(document.title).toBe("Something went wrong showing this page - WSO2 Cloud Status");
    expect(screen.getByRole("alert")).toHaveTextContent("This page will try again on its own.");
    expect(screen.queryByRole("link")).toBeNull();
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });

  it("renders the page again after a summary interval, so a crashed tab recovers", () => {
    vi.useFakeTimers();
    let broken = true;
    const Flaky = () => {
      if (broken) throw new Error("bad data");
      return <p>Status is back</p>;
    };
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    render(
      <ErrorBoundary>
        <Flaky />
      </ErrorBoundary>,
    );
    expect(screen.getByRole("alert")).toHaveTextContent("will try again on its own");
    broken = false;
    act(() => {
      vi.advanceTimersByTime(30_000);
    });
    expect(screen.getByText("Status is back")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).toBeNull();
    spy.mockRestore();
    vi.useRealTimers();
  });
});
