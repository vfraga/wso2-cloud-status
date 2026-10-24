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
import { STATUSES } from "../api/types";
import { DARK, LIGHT, statusVar, tokenCss, type Palette } from "./tokens";

function luminance(hex: string): number {
  const channels = [1, 3, 5].map((i) => {
    const v = parseInt(hex.slice(i, i + 2), 16) / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * (channels[0] ?? 0) + 0.7152 * (channels[1] ?? 0) + 0.0722 * (channels[2] ?? 0);
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return ((hi ?? 0) + 0.05) / ((lo ?? 0) + 0.05);
}

describe.each([
  ["light", LIGHT],
  ["dark", DARK],
] as [string, Palette][])("%s palette meets WCAG 2.2 AA", (_name, p) => {
  it("text and muted text on surface and page", () => {
    for (const bg of [p.surface, p.page]) {
      expect(contrast(p.text, bg)).toBeGreaterThanOrEqual(4.5);
      expect(contrast(p.muted, bg)).toBeGreaterThanOrEqual(4.5);
    }
    expect(contrast(p.focus, p.surface)).toBeGreaterThanOrEqual(3);
  });

  it.each(STATUSES)(
    "%s: text on surface, page and tint; fill as a graphic on surface",
    (status) => {
      const c = p.status[status];
      expect(contrast(c.fg, p.surface)).toBeGreaterThanOrEqual(4.5);
      expect(contrast(c.fg, p.page)).toBeGreaterThanOrEqual(4.5);
      expect(contrast(c.fg, c.tint)).toBeGreaterThanOrEqual(4.5);
      expect(contrast(c.fill, p.surface)).toBeGreaterThanOrEqual(3);
    },
  );
});

describe("tokenCss", () => {
  it("declares every status token for both schemes", () => {
    const css = tokenCss();
    for (const status of STATUSES) {
      expect(css).toContain(`--cs-${status}-fg`);
    }
    expect(css).toContain('[data-color-scheme="dark"]');
    expect(css).toContain("prefers-color-scheme: dark");
    expect(statusVar("outage", "tint")).toBe("var(--cs-outage-tint)");
  });
});
