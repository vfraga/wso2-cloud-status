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

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { act, render, renderHook, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Link, matchRoute, navigate, usePathname } from "./router";

afterEach(() => {
  window.history.pushState(null, "", "/");
});

describe("matchRoute", () => {
  it.each([
    ["/", { name: "home" }],
    ["", { name: "home" }],
    ["/products/api-platform", { name: "product", id: "api-platform" }],
    ["/products/api-platform/", { name: "product", id: "api-platform" }],
    ["/products/Bad_ID", { name: "missing" }],
    ["/elsewhere", { name: "missing" }],
    ["/%68istory", { name: "history" }],
    ["/products/api%2Dplatform", { name: "product", id: "api-platform" }],
    ["/history%0a", { name: "missing" }],
    ["/products/%E0%A4%A", { name: "missing" }],
  ])("%s", (path, route) => {
    expect(matchRoute(path)).toEqual(route);
  });
});

// nginx serves the HTML shell only on the paths this router knows and answers
// any other with a 404, so the two must agree. nginx matches the decoded path,
// and its \z (the end of the path) is JavaScript's $.
describe("nginx's shell paths", () => {
  // A path, not a URL object: jsdom replaces the global URL, which node:fs rejects.
  const here = dirname(fileURLToPath(import.meta.url));
  const conf = readFileSync(resolve(here, "../../docker/nginx.conf"), "utf8");
  const pattern =
    /location ~ "([^"]+)" \{\s*include \/etc\/nginx\/snippets\/origin-lock\.conf;\s*try_files \/index\.html/.exec(
      conf,
    )?.[1];

  it.each([
    "/",
    "//",
    "/history",
    "/history/",
    "/products/api-platform",
    "/products/api-platform/",
    "/products/Bad_ID",
    "/products/",
    "/products/a/b",
    "/history/x",
    "/elsewhere",
    "/assets",
    "/%68istory",
    "/products/api%2Dplatform",
    "/history%0a",
    "/products/x%0a",
  ])("%s", (path) => {
    expect(pattern).toMatch(/\\z$/);
    const nginx = new RegExp((pattern ?? "").replace(/\\z$/, "$"));
    expect(nginx.test(decodeURIComponent(path))).toBe(matchRoute(path).name !== "missing");
  });
});

describe("navigation", () => {
  it("updates the pathname hook", () => {
    const { result } = renderHook(() => usePathname());
    expect(result.current).toBe("/");
    act(() => {
      navigate("/products/x");
    });
    expect(result.current).toBe("/products/x");
    act(() => {
      navigate("/products/x");
    });
    expect(result.current).toBe("/products/x");
  });

  it("starts a new view at the top", () => {
    const scroll = vi.spyOn(window, "scrollTo").mockImplementation(() => undefined);
    act(() => {
      navigate("/products/z");
    });
    expect(scroll).toHaveBeenCalledWith(0, 0);
    scroll.mockRestore();
  });

  it("follows a plain click in place and leaves modified clicks alone", async () => {
    const user = userEvent.setup();
    render(
      <Link
        to="/products/y"
        onClick={(e) => {
          if (e.ctrlKey) e.preventDefault();
        }}
      >
        Go
      </Link>,
    );
    const link = screen.getByRole("link", { name: "Go" });
    expect(link).toHaveAttribute("href", "/products/y");
    await user.keyboard("{Control>}");
    await user.click(link);
    await user.keyboard("{/Control}");
    expect(window.location.pathname).toBe("/");
    await user.click(link);
    expect(window.location.pathname).toBe("/products/y");
  });
});
