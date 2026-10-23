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

import { describe, expect, it } from "vitest";
import type { ProductSummary, RegionSummary, Status, Summary } from "../api/types";
import { parseSummary } from "../api/parse";
import { product } from "../test/factories";
import { productHeadline, summaryHeadline } from "./headline";
import {
  capitalise,
  count,
  daysWithIncidents,
  listNames,
  othersOperational,
  quietDayText,
  regionsAffected,
  regionsUnavailable,
} from "./status";

const RANK: Record<Status, number> = {
  unknown: 0,
  operational: 1,
  maintenance: 2,
  degraded: 3,
  outage: 4,
};

/** The most severe known status, unknown only when every input is. */
const worst = (statuses: readonly Status[]): Status =>
  statuses.reduce<Status>((w, s) => (RANK[s] > RANK[w] ? s : w), "unknown");

const region = (name: string, status: Status): RegionSummary => ({
  id: name.toLowerCase().replaceAll(" ", "-"),
  name,
  status,
  pageUrl: "",
});

/** A product whose status and completeness follow from its regions, as the backend computes them. */
function p(name: string, ...regions: [string, Status][]): ProductSummary {
  const list = regions.map(([n, s]) => region(n, s));
  return product({
    id: name.toLowerCase().replaceAll(" ", "-"),
    name,
    regions: list,
    status: worst(list.map((r) => r.status)),
    affectedRegions: list.filter((r) => r.status !== "operational" && r.status !== "unknown")
      .length,
    dataComplete: list.length > 0 && list.every((r) => r.status !== "unknown"),
  });
}

/** A summary as statusd computes it: unknown when data is missing and no problem is known. */
function summary(...products: ProductSummary[]): Summary {
  const dataComplete = products.every((x) => x.dataComplete && x.status !== "unknown");
  const known = worst(products.map((x) => x.status));
  return {
    status: !dataComplete && RANK[known] <= RANK.operational ? "unknown" : known,
    dataComplete,
    products,
    activeIncidents: [],
  };
}

const ok = (name: string) => p(name, ["US", "operational"], ["EU", "operational"]);

describe("summaryHeadline", () => {
  it("says all systems operational only when every product is known and complete", () => {
    expect(summaryHeadline(summary(ok("A"), ok("B")))).toEqual({
      status: "operational",
      label: "All systems operational",
    });
  });

  it("turns grey and names an unknown product, with the others operational", () => {
    const moesif = p("Moesif", ["US", "unknown"]);
    expect(summaryHeadline(summary(ok("A"), ok("B"), moesif))).toEqual({
      status: "unknown",
      label: "Status unavailable for Moesif",
      detail: "The other 2 products are operational.",
    });
    expect(
      summaryHeadline(summary(ok("A"), moesif, p("Agent Platform", ["US", "unknown"]))),
    ).toEqual({
      status: "unknown",
      label: "Status unavailable for Moesif and Agent Platform",
      detail: "The other product is operational.",
    });
  });

  it("counts more than three unknown products in the headline and names them below", () => {
    const unknown = ["A", "B", "C", "D"].map((n) => p(n, ["US", "unknown"]));
    expect(summaryHeadline(summary(ok("E"), ...unknown))).toEqual({
      status: "unknown",
      label: "Status unavailable for 4 products",
      detail: "Status unavailable for A, B, C and D. The other product is operational.",
    });
  });

  it("names an unknown product once: not again under the headline when the notice names it", () => {
    const late = (name: string) => ({
      ...p(name, ["US", "unknown"]),
      freshness: {
        checkedAt: { components: null, incidents: null, uptime: null },
        stale: { components: true, incidents: true, uptime: true },
      },
    });
    const unknown = ["A", "B", "C", "D"].map(late);
    // The notice lists the four with their last check, so the line does not.
    expect(summaryHeadline(summary(ok("E"), ...unknown))).toEqual({
      status: "unknown",
      label: "Status unavailable for 4 products",
      detail: "The other product is operational.",
    });
    // A known problem leads; the late product is still left to the notice.
    const api = p("API Platform", ["US", "degraded"]);
    expect(summaryHeadline(summary(api, late("Moesif"))).detail).toBe(
      "Affected: API Platform (US).",
    );
  });

  it("reads partial data as grey with the products and the regions missing", () => {
    const dev = p(
      "Developer Platform",
      ["US", "operational"],
      ["EU CP", "unknown"],
      ["EU DP", "unknown"],
    );
    const components = product({ id: "c", name: "C", dataComplete: false });
    expect(summaryHeadline(summary(ok("A"), dev, components))).toMatchObject({
      status: "unknown",
      label: "Some status data is unavailable",
      detail:
        "Developer Platform: 2 of 3 regions unavailable. C: some component data is unavailable. The other product is operational.",
    });
  });

  it("keeps a problem as the headline and names products, regions and the missing part below", () => {
    const api = p("API Platform", ["US", "operational"], ["EU Data Plane", "degraded"]);
    const idp = p("Identity Platform", ["US", "outage"], ["EU", "degraded"]);
    const moesif = p("Moesif", ["US", "unknown"]);
    expect(summaryHeadline(summary(api, ok("A"), moesif))).toMatchObject({
      status: "degraded",
      label: "Degraded performance",
      detail:
        "Affected: API Platform (EU Data Plane). Status unavailable for Moesif. The other product is operational.",
    });
    // Mixed statuses are grouped, worst first, so a degraded region never reads as an outage.
    expect(summaryHeadline(summary(api, idp))).toMatchObject({
      status: "outage",
      label: "Service outage",
      detail:
        "Service outage: Identity Platform (US). Degraded performance: API Platform (EU Data Plane) and Identity Platform (EU).",
    });
  });

  it("never lists maintenance under an outage", () => {
    const api = p("API Platform", ["US", "operational"], ["EU Control Plane", "maintenance"]);
    const integration = p("Integration Platform", ["EU Control Plane", "outage"]);
    const moesif = p("Moesif", ["US", "unknown"]);
    expect(
      summaryHeadline(summary(api, integration, moesif, ok("A"), ok("B"), ok("C"))),
    ).toMatchObject({
      status: "outage",
      label: "Service outage",
      detail:
        "Service outage: Integration Platform (EU Control Plane). Under maintenance: API Platform (EU Control Plane). Status unavailable for Moesif. The other 3 products are operational.",
    });
    // Three statuses, and one product in two groups.
    const idp = p("Identity Platform", ["US", "degraded"], ["EU", "maintenance"]);
    expect(summaryHeadline(summary(integration, idp)).detail).toBe(
      "Service outage: Integration Platform (EU Control Plane). Degraded performance: Identity Platform (US). Under maintenance: Identity Platform (EU).",
    );
  });

  it("names a product whose status comes from an incident under that status", () => {
    // An outage incident on a product whose only affected region is degraded.
    const api = product({
      name: "API Platform",
      status: "outage",
      regions: [region("EU", "degraded")],
    });
    const maintained = product({ id: "m", name: "M", status: "maintenance", regions: [] });
    expect(summaryHeadline(summary(api, maintained)).detail).toBe(
      "Service outage: API Platform. Degraded performance: API Platform (EU). Under maintenance: M.",
    );
  });

  it("names a product with an incident but no affected region by name alone", () => {
    const incidentOnly = product({ name: "API Platform", status: "maintenance" });
    expect(summaryHeadline(summary(incidentOnly, ok("A")))).toEqual({
      status: "maintenance",
      label: "Under maintenance",
      detail: "Affected: API Platform. The other product is operational.",
    });
  });

  it("is unavailable when nothing is known", () => {
    expect(summaryHeadline(summary(p("A", ["US", "unknown"])))).toEqual({
      status: "unknown",
      label: "Status unavailable",
    });
    expect(
      summaryHeadline({ status: "unknown", dataComplete: true, products: [], activeIncidents: [] }),
    ).toEqual({ status: "unknown", label: "Status unavailable" });
  });

  it("renders the API's status and never computes its own", () => {
    // The API's status wins over what the products alone would give.
    expect(summaryHeadline({ ...summary(ok("A")), status: "outage" })).toEqual({
      status: "outage",
      label: "Service outage",
    });
    // Unknown with every product known: missing data that no product names.
    expect(summaryHeadline({ ...summary(ok("A")), status: "unknown" })).toEqual({
      status: "unknown",
      label: "Some status data is unavailable",
    });
  });

  it("fails closed through the parser for drifted bodies", () => {
    const good = {
      id: "a",
      name: "A",
      page_url: "",
      status: "operational",
      affected_regions: 0,
      data_complete: true,
      outdated: false,
      regions: [{ id: "us", name: "US", status: "operational", page_url: "" }],
      history: [],
    };
    const label = (body: unknown) => summaryHeadline(parseSummary(body)).label;
    expect(label({ status: "operational", data_complete: true, products: [] })).toBe(
      "Status unavailable",
    );
    expect(
      label({
        status: "outage",
        data_complete: false,
        products: [good, { name: "B", status: "outage" }],
      }),
    ).toBe("Service outage");
    const noField = Object.fromEntries(
      Object.entries(good).filter(([key]) => key !== "data_complete"),
    );
    expect(
      label({
        status: "operational",
        products: [
          { ...noField, regions: [{ id: "us", name: "US", status: "unknown", page_url: "" }] },
        ],
      }),
    ).toBe("Some status data is unavailable");
    expect(label({ status: "operational", data_complete: true, products: [good] })).toBe(
      "All systems operational",
    );
  });
});

describe("detail lines", () => {
  it("lists each status on its own line when more than one is named, the rest after", () => {
    const api = p("API Platform", ["US", "operational"], ["EU Control Plane", "maintenance"]);
    const integration = p("Integration Platform", ["EU Control Plane", "outage"]);
    const moesif = p("Moesif", ["US", "unknown"]);
    const headline = summaryHeadline(summary(api, integration, moesif, ok("A")));
    expect(headline.lines).toEqual([
      { status: "outage", text: "Service outage: Integration Platform (EU Control Plane)." },
      { status: "maintenance", text: "Under maintenance: API Platform (EU Control Plane)." },
      { status: "unknown", text: "Status unavailable for Moesif." },
      { status: null, text: "The other product is operational." },
    ]);
    // The paragraph says the same.
    expect(headline.detail).toBe(headline.lines?.map((l) => l.text).join(" "));
  });

  it("keeps one paragraph when a single status is named", () => {
    const api = p("API Platform", ["US", "operational"], ["EU Data Plane", "degraded"]);
    const headline = summaryHeadline(summary(api, ok("A")));
    expect(headline.detail).toBe(
      "Affected: API Platform (EU Data Plane). The other product is operational.",
    );
    expect(headline).not.toHaveProperty("lines");
  });
});

describe("productHeadline", () => {
  it("matches the summary rules for one product", () => {
    expect(productHeadline(ok("A"))).toMatchObject({
      status: "operational",
      label: "All systems operational",
    });
    expect(productHeadline(p("A", ["US", "unknown"]))).toMatchObject({
      status: "unknown",
      label: "Status unavailable",
    });
    expect(productHeadline(p("A", ["US", "operational"], ["EU", "unknown"]))).toMatchObject({
      status: "unknown",
      label: "Some status data is unavailable",
      detail: "1 of 2 regions unavailable.",
    });
    expect(productHeadline(p("A", ["US", "degraded"], ["EU", "unknown"]))).toMatchObject({
      status: "degraded",
      label: "Degraded performance",
      detail: "Affected: US. 1 of 2 regions unavailable.",
    });
    expect(productHeadline(product({ dataComplete: false }))).toMatchObject({
      status: "unknown",
      label: "Some status data is unavailable",
      detail: "Some component data is unavailable.",
    });
    expect(productHeadline(product({ status: "outage" }))).toMatchObject({
      status: "outage",
      label: "Service outage",
    });
  });

  it("groups the regions by status, worst first, when they differ", () => {
    expect(
      productHeadline(p("A", ["US", "degraded"], ["EU", "outage"], ["IN", "maintenance"])),
    ).toMatchObject({
      status: "outage",
      label: "Service outage",
      detail: "Service outage: EU. Degraded performance: US. Under maintenance: IN.",
    });
    expect(productHeadline(p("A", ["US", "outage"], ["EU", "outage"]))).toMatchObject({
      status: "outage",
      label: "Service outage",
      detail: "Affected: US and EU.",
    });
    // An outage from an incident over a degraded region: the region keeps its own status.
    expect(
      productHeadline(product({ status: "outage", regions: [region("EU", "degraded")] })),
    ).toMatchObject({
      status: "outage",
      label: "Service outage",
      detail: "Degraded performance: EU.",
    });
  });
});

describe("status wording", () => {
  it("lists, counts and pluralises", () => {
    expect(listNames([])).toBe("");
    expect(listNames(["A"])).toBe("A");
    expect(listNames(["A", "B"])).toBe("A and B");
    expect(listNames(["A", "B", "C"])).toBe("A, B and C");
    expect(count(1, "day")).toBe("1 day");
    expect(count(2, "day")).toBe("2 days");
    expect(daysWithIncidents(1)).toBe("1 day with incidents");
    expect(regionsAffected(1, 1)).toBe("1 of 1 region affected");
    expect(regionsUnavailable(2, 5)).toBe("2 of 5 regions unavailable");
    expect(othersOperational(1)).toBe("The other product is operational.");
    expect(othersOperational(5)).toBe("The other 5 products are operational.");
    expect(capitalise("some data")).toBe("Some data");
  });

  it("says what a quiet day means when some incident data is missing", () => {
    expect(quietDayText(0, 6)).toBe("No incidents reported.");
    expect(quietDayText(1, 6)).toBe("No incidents reported for the other products.");
    expect(quietDayText(1, 2)).toBe("No incidents reported for the other product.");
    expect(quietDayText(2, 2)).toBe("No incident information is available.");
  });
});
