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

import { act, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Status } from "../api/types";
import type { Headline } from "../lib/headline";
import { BANNER_LABEL } from "../lib/status";
import { wrap } from "../test/render";
import { ThemeRoot } from "../theme/ThemeRoot";
import { Banner } from "./Banner";

afterEach(() => {
  vi.useRealTimers();
});

describe("Banner", () => {
  const base = { loading: false, checkedAt: null, lastSuccessAt: new Date(), failed: false };
  const headline = (status: Status, detail?: string): Headline => ({
    status,
    label: BANNER_LABEL[status],
    ...(detail === undefined ? {} : { detail }),
  });

  it("shows icon-backed text for each status, with the line under it", () => {
    const { rerender } = wrap(
      <Banner {...base} headline={headline("outage", "Affected: API Platform (EU).")} />,
    );
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Service outage");
    expect(screen.getByText("Affected: API Platform (EU).")).toBeInTheDocument();
    rerender(
      <ThemeRoot>
        <Banner {...base} headline={headline("unknown")} loading />
      </ThemeRoot>,
    );
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Checking status");
  });

  it("lists the statuses under the headline when it names more than one", () => {
    const lines = [
      { status: "outage" as const, text: "Service outage: Integration Platform (EU)." },
      { status: "maintenance" as const, text: "Under maintenance: API Platform (EU)." },
      { status: null, text: "The other 4 products are operational." },
    ];
    wrap(
      <Banner
        {...base}
        headline={{
          ...headline("outage"),
          detail: lines.map((l) => l.text).join(" "),
          lines,
        }}
      />,
    );
    const banner = screen.getByRole("region", { name: "Overall status" });
    const items = within(banner).getAllByRole("listitem");
    expect(items.map((i) => i.textContent)).toEqual([lines[0]!.text, lines[1]!.text]);
    expect(items[0]!.querySelector("svg[aria-hidden='true']")).not.toBeNull();
    expect(within(banner).getByText("The other 4 products are operational.")).toBeInTheDocument();
  });

  it("names the subject for screen readers and can take focus", () => {
    wrap(<Banner {...base} headline={headline("degraded")} subject="API Platform" />);
    const heading = screen.getByRole("heading", { level: 1 });
    expect(heading).toHaveAccessibleName("API Platform: Degraded performance");
    expect(heading).toHaveAttribute("tabindex", "-1");
  });

  it("shows a calm notice when the API is unreachable", () => {
    wrap(<Banner {...base} headline={headline("operational")} failed />);
    expect(screen.getByRole("status")).toHaveTextContent("Status data may be out of date");
  });

  it("says it cannot reach the service when nothing has loaded yet", () => {
    wrap(<Banner {...base} lastSuccessAt={null} headline={headline("unknown")} failed />);
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Status unavailable");
    expect(screen.getByRole("status")).toHaveTextContent(
      "We cannot reach the status service right now. This page will keep trying.",
    );
    expect(screen.getByRole("status")).not.toHaveTextContent("out of date");
  });

  it("shows the notice when the data is more than five minutes old", () => {
    wrap(
      <Banner
        {...base}
        headline={headline("operational")}
        checkedAt={new Date(Date.now() - 6 * 60_000)}
      />,
    );
    expect(screen.getByRole("status")).toHaveTextContent("more than 5 minutes ago");
    expect(screen.getByText("Status checked 6 min ago")).toBeInTheDocument();
  });

  it("keeps an empty live region mounted for fresh data", () => {
    wrap(
      <Banner
        {...base}
        headline={headline("operational")}
        checkedAt={new Date(Date.now() - 20_000)}
      />,
    );
    expect(screen.getByRole("status")).toBeEmptyDOMElement();
    expect(screen.getByText("Status checked just now")).toBeInTheDocument();
  });

  it.each([
    // checked_at is floored and can trail the latest check by a minute.
    [100_000, "Status checked just now"],
    [170_000, "Status checked 1 min ago"],
    [4 * 60_000 + 50_000, "Status checked 3 min ago"],
  ])("counts current data's age from the end of its minute (%d ms)", (ms, text) => {
    wrap(
      <Banner {...base} headline={headline("operational")} checkedAt={new Date(Date.now() - ms)} />,
    );
    expect(screen.getByText(text)).toBeInTheDocument();
    expect(screen.getByRole("status")).toBeEmptyDOMElement();
  });

  it("reads Status unavailable once the page has not refreshed for longer than the limit", () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
    vi.setSystemTime(new Date("2026-10-20T12:00:00Z"));
    wrap(
      <Banner
        {...base}
        lastSuccessAt={new Date()}
        headline={headline("degraded", "Affected: API Platform.")}
        secondary="Incident information for Moesif has not been updated since 11:50 UTC."
        failed
      />,
    );
    const heading = screen.getByRole("heading", { level: 1 });
    const live = screen.getByRole("status");
    expect(heading).toHaveTextContent("Degraded performance");
    expect(live).toHaveTextContent("We could not refresh it just now");
    act(() => {
      vi.advanceTimersByTime(5 * 60_000);
    });
    expect(heading).toHaveTextContent("Degraded performance");
    act(() => {
      vi.advanceTimersByTime(5_000);
    });
    expect(heading).toHaveTextContent("Status unavailable");
    // The lines under the headline described the data the banner no longer vouches for.
    expect(screen.queryByText("Affected: API Platform.")).not.toBeInTheDocument();
    expect(screen.queryByText(/^Incident information for Moesif/)).not.toBeInTheDocument();
    // The same live region, so the change is announced.
    expect(screen.getByRole("status")).toBe(live);
    expect(live).toHaveTextContent(
      "Status data may be out of date. We have not been able to refresh it for more than 5 minutes, so this page shows the last known state. We will keep trying.",
    );
  });

  it("reads Status unavailable for a response that was already too old on arrival", () => {
    wrap(
      <Banner
        {...base}
        headline={headline("operational")}
        checkedAt={new Date(Date.now() - 3 * 3_600_000)}
        servedStale
      />,
    );
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Status unavailable");
    expect(screen.getByText("Status checked 3 hours ago")).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent(
      "Status data may be out of date. The data we received was last checked more than 5 minutes ago, so this page cannot confirm the current status.",
    );
  });

  it("keeps the status while the latest attempt has not failed, however old the data", () => {
    wrap(
      <Banner
        {...base}
        headline={headline("operational")}
        checkedAt={new Date(Date.now() - 20 * 60_000)}
        lastSuccessAt={new Date(Date.now() - 20 * 60_000)}
        failed={false}
      />,
    );
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("All systems operational");
    expect(screen.getByRole("status")).toHaveTextContent(
      "The last check was more than 5 minutes ago.",
    );
  });

  it("announces the notice in the same live region when data turns stale", () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
    vi.setSystemTime(new Date("2026-10-20T12:00:00Z"));
    wrap(
      <Banner
        {...base}
        headline={headline("operational")}
        checkedAt={new Date("2026-10-20T11:56:00Z")}
        lastSuccessAt={new Date()}
      />,
    );
    const live = screen.getByRole("status");
    expect(live).toBeEmptyDOMElement();
    act(() => {
      vi.advanceTimersByTime(65_000);
    });
    expect(screen.getByRole("status")).toBe(live);
    expect(live).toHaveTextContent("The last check was more than 5 minutes ago.");
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("All systems operational");
  });

  it("announces a change of the headline on an open page, not the first status", () => {
    const { container, rerender } = wrap(
      <Banner {...base} loading headline={headline("unknown")} />,
    );
    const announcer = container.querySelector('[aria-live="polite"]')!;
    rerender(
      <ThemeRoot>
        <Banner {...base} headline={headline("operational")} />
      </ThemeRoot>,
    );
    expect(announcer).toBeEmptyDOMElement();
    rerender(
      <ThemeRoot>
        <Banner {...base} headline={headline("outage")} />
      </ThemeRoot>,
    );
    expect(announcer).toHaveTextContent("Status changed: Service outage.");
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Service outage");
    // A later notice is its own region: it does not repeat the change.
    rerender(
      <ThemeRoot>
        <Banner {...base} headline={headline("outage")} failed />
      </ThemeRoot>,
    );
    expect(screen.getByRole("status")).toHaveTextContent("We could not refresh it just now");
    expect(screen.getByRole("status")).not.toHaveTextContent("Status changed");
  });

  it("says the age line covers the other products when some are late", () => {
    wrap(<Banner {...base} headline={headline("unknown")} checkedAt={new Date()} someLate />);
    expect(screen.getByText(/^Other products checked /)).toBeInTheDocument();
  });
});
