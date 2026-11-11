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

import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { describe, expect, it } from "vitest";
import { App } from "./App";
import { navigate } from "./lib/router";
import {
  degradedSummary,
  expectHeadingFocused,
  expectTitle,
  mockApi,
  productDetail as detail,
  serve,
  server,
} from "./test/app";
import { summaryBody } from "./test/factories";

mockApi();

describe("navigation", () => {
  it("navigates from the home page to a product and back", async () => {
    const user = userEvent.setup();
    serve(degradedSummary());
    server.use(
      http.get("http://api.test/api/v1/products/api-platform", () => HttpResponse.json(detail())),
    );
    render(<App />);
    const products = await screen.findByRole("region", { name: "Products" });
    await user.click(await within(products).findByRole("link", { name: "API Platform" }));
    expect(await screen.findByText("API Proxy Invocation")).toBeInTheDocument();
    // The new view is announced: its h1 has focus and the tab has its own title.
    await expectHeadingFocused("API Platform (Bijira): Degraded performance");
    await expectTitle("API Platform - WSO2 Cloud Status");
    await user.click(screen.getByRole("link", { name: "All products" }));
    await expectHeadingFocused("Degraded performance: API Platform");
    await expectTitle("WSO2 Cloud Status");
    await act(async () => {
      await Promise.resolve();
    });
  });

  it("focuses the h1 only once the status is in, so the status is what is announced", async () => {
    const user = userEvent.setup();
    serve(degradedSummary());
    server.use(
      http.get("http://api.test/api/v1/products/api-platform", async () => {
        await new Promise((done) => setTimeout(done, 300));
        return HttpResponse.json(detail());
      }),
    );
    const focused: string[] = [];
    const record = (event: FocusEvent): void => {
      const target = event.target as HTMLElement;
      if (target.tagName === "H1") focused.push(target.textContent);
    };
    document.addEventListener("focusin", record);
    try {
      render(<App />);
      const products = await screen.findByRole("region", { name: "Products" });
      await user.click(await within(products).findByRole("link", { name: "API Platform" }));
      expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Checking status");
      expect(screen.getByRole("heading", { level: 1 })).not.toHaveFocus();
      await waitFor(() => {
        expect(screen.getByRole("heading", { level: 1 })).toHaveFocus();
      });
      expect(focused).toEqual(["API Platform (Bijira): Degraded performance"]);
    } finally {
      document.removeEventListener("focusin", record);
    }
  });

  it("focuses the h1 of a failed view, and never takes focus the reader moved elsewhere", async () => {
    const user = userEvent.setup();
    serve(degradedSummary());
    server.use(
      http.get("http://api.test/api/v1/products/moesif", async () => {
        await new Promise((done) => setTimeout(done, 200));
        return new HttpResponse(null, { status: 503 });
      }),
      http.get("http://api.test/api/v1/products/api-platform", async () => {
        await new Promise((done) => setTimeout(done, 200));
        return HttpResponse.json(detail());
      }),
    );
    render(<App />);
    const products = await screen.findByRole("region", { name: "Products" });
    await user.click(await within(products).findByRole("link", { name: "Moesif" }));
    const heading = screen.getByRole("heading", { level: 1 });
    await waitFor(() => {
      expect(heading).toHaveFocus();
    });
    expect(heading).toHaveTextContent("Moesif: Status unavailable");
    // Back home, then to a product, moving focus to the theme toggle before its data arrives.
    await user.click(screen.getByRole("link", { name: "All products" }));
    await user.click(
      await within(await screen.findByRole("region", { name: "Products" })).findByRole("link", {
        name: "API Platform",
      }),
    );
    const toggle = screen.getByRole("button", { name: /Switch to (dark|light) mode/ });
    toggle.focus();
    expect(
      await screen.findByRole("heading", {
        level: 1,
        name: "API Platform (Bijira): Degraded performance",
      }),
    ).not.toHaveFocus();
    expect(toggle).toHaveFocus();
  });

  it("focuses the not-found message that replaces a product page", async () => {
    serve(summaryBody());
    server.use(
      http.get("http://api.test/api/v1/products/retired", async () => {
        await new Promise((done) => setTimeout(done, 100));
        return HttpResponse.json({ title: "Not Found" }, { status: 404 });
      }),
    );
    render(<App />);
    await screen.findByRole("heading", { level: 1, name: "All systems operational" });
    act(() => {
      navigate("/products/retired");
    });
    await expectHeadingFocused("We could not find that product");
  });

  it("shows a not-found page for an unknown route", () => {
    window.history.pushState(null, "", "/nothing/here");
    render(<App />);
    expect(
      screen.getByRole("heading", { name: "We could not find that page" }),
    ).toBeInTheDocument();
  });

  it("moves focus to the not-found heading after an in-page navigation to an unknown route", async () => {
    serve(summaryBody());
    render(<App />);
    await screen.findByRole("heading", { level: 1, name: "All systems operational" });
    act(() => {
      navigate("/nothing/here");
    });
    await expectHeadingFocused("We could not find that page");
  });
});

describe("header", () => {
  it("leads home with the WSO2 logo, drawn in the logo colour and hidden from screen readers", async () => {
    serve(summaryBody());
    render(<App />);
    const home = await screen.findByRole("link", { name: "WSO2 Cloud Status, home" });
    const logo = home.querySelector("svg");
    expect(logo).toHaveAttribute("aria-hidden", "true");
    expect(logo?.querySelectorAll("path")).toHaveLength(6);
    expect(home).toHaveTextContent("Cloud Status");
  });
});

describe("footer", () => {
  it("links WSO2's legal pages", async () => {
    serve(summaryBody());
    render(<App />);
    const legal = await screen.findByRole("navigation", { name: "Legal" });
    expect(
      within(legal)
        .getAllByRole("link")
        .map((a) => [a.textContent, a.getAttribute("href")]),
    ).toEqual([
      ["Privacy policy", "https://wso2.com/privacy-policy"],
      ["Cookie policy", "https://wso2.com/cookie-policy"],
      ["Terms of use", "https://wso2.com/terms-of-use"],
      ["Modern slavery statement", "https://wso2.com/modern-slavery-statement"],
      ["Do not sell my personal information", "https://wso2.com/california-privacy#opt-out"],
    ]);
  });
});

describe("theme toggle", () => {
  it("switches between light and dark", async () => {
    const user = userEvent.setup();
    serve(summaryBody());
    render(<App />);
    const toggle = await screen.findByRole("button", { name: "Switch to dark mode" });
    await user.click(toggle);
    expect(await screen.findByRole("button", { name: "Switch to light mode" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Switch to light mode" }));
    expect(await screen.findByRole("button", { name: "Switch to dark mode" })).toBeInTheDocument();
  });
});
