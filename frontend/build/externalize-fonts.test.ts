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

import { WSO2Theme } from "@wso2/oxygen-ui";
import { describe, expect, it } from "vitest";
import { externalize, externalizeFonts, fileStem, PAGE_FONT } from "./externalize-fonts.ts";

describe("PAGE_FONT", () => {
  it("is the font family of the theme the page renders with", () => {
    expect(WSO2Theme.typography.fontFamily?.split(",")[0]?.trim()).toBe(`'${PAGE_FONT}'`);
  });
});

const LATIN_EXT = "U+0100-02BA,U+02BD-02C5";
const LATIN = "U+0000-00FF,U+0131,U+0152-0153";

// One family's two subsets, written the way Oxygen UI's bundle writes them.
function family(name: string, seed: string): string {
  const face = (subset: string, range: string) => `/* ${seed}-${subset}-wght-normal */
@font-face {
  font-family: '${name}';
  font-style: normal;
  font-display: swap;
  font-weight: 100 900;
  src: url(data:font/woff2;base64,${Buffer.from(`${seed}-${subset}`).toString("base64")}) format('woff2-variations');
  unicode-range: ${range};
}
`;
  return face("latin-ext", LATIN_EXT) + face("latin", LATIN);
}

const inter = family("Inter Variable", "inter");
const sora = family("Sora Variable", "sora");
const chunk = (...css: string[]) =>
  css.map((c) => `(function(){style.textContent = \`${c}\`;})();`).join("\n");

describe("externalize", () => {
  it.each([
    ["the page font first", chunk(inter, sora)],
    ["the page font last", chunk(sora, inter)],
  ])(
    "names each file after its family and preloads the page font's Latin subset, %s",
    (_, code) => {
      const result = externalize(code, "/", PAGE_FONT);

      expect(result.files).toHaveLength(4);
      const contents = Object.fromEntries(
        result.files.map((f) => [f.source.toString(), f.fileName]),
      );
      expect(contents["inter-latin"]).toMatch(/^assets\/inter-[0-9a-f]{8}\.woff2$/);
      expect(contents["inter-latin-ext"]).toMatch(/^assets\/inter-[0-9a-f]{8}\.woff2$/);
      expect(contents["sora-latin"]).toMatch(/^assets\/sora-[0-9a-f]{8}\.woff2$/);
      expect(contents["sora-latin-ext"]).toMatch(/^assets\/sora-[0-9a-f]{8}\.woff2$/);
      expect(result.latinHref).toBe(`/${contents["inter-latin"]}`);
      expect(result.code).not.toContain("data:font/woff2");
      for (const file of result.files) expect(result.code).toContain(`url(/${file.fileName})`);
    },
  );

  it("finds no Latin subset when the page font is not in the code", () => {
    expect(externalize(chunk(sora), "/", PAGE_FONT).latinHref).toBeNull();
  });

  it("finds the family in minified CSS too", () => {
    const code = sora.replace(/\s+/g, " ").replace(/: /g, ":");
    const result = externalize(code, "/base/", "Sora Variable");
    for (const file of result.files) expect(file.fileName).toMatch(/^assets\/sora-/);
    expect(result.latinHref).toMatch(/^\/base\/assets\/sora-[0-9a-f]{8}\.woff2$/);
  });

  it("reads a family name in double quotes or none", () => {
    const code = (quote: string) =>
      family("Noto Sans", "noto").replaceAll("'Noto Sans'", `${quote}Noto Sans${quote}`);
    for (const quote of ['"', ""]) {
      const result = externalize(code(quote), "/", "Noto Sans");
      for (const file of result.files) expect(file.fileName).toMatch(/^assets\/noto-sans-/);
      expect(result.latinHref).not.toBeNull();
    }
  });
});

describe("fileStem", () => {
  it.each([
    ["Inter Variable", "inter"],
    ["Sora Variable", "sora"],
    ["Noto Sans Mono", "noto-sans-mono"],
    ["", "font"],
  ])("%j becomes %j", (name, stem) => {
    expect(fileStem(name)).toBe(stem);
  });
});

describe("externalizeFonts", () => {
  type Handler = () => unknown;
  const preload = (plugin: ReturnType<typeof externalizeFonts>) =>
    (plugin.transformIndexHtml as { handler: Handler }).handler();

  it("fails the build when the bundle holds no Latin subset of the page font", () => {
    expect(() => preload(externalizeFonts())).toThrow(/no Latin subset of "Inter Variable"/);
  });
});
