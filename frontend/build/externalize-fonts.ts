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

import { createHash } from "node:crypto";
import type { Plugin } from "vite";

/** The font family the page's theme (Oxygen UI's WSO2Theme) sets; its Latin subset is preloaded. */
export const PAGE_FONT = "Inter Variable";

const DATA_FONT = /data:font\/woff2;base64,([A-Za-z0-9+/=]+)/g;
const FAMILY = /font-family:([^;]*);/g;
const LATIN_RANGE = "unicode-range:U+0000-00FF";

export interface FontFile {
  fileName: string;
  source: Buffer;
}

export interface Externalized {
  code: string;
  files: FontFile[];
  /** The URL of the page font's Latin subset, when this code holds it. */
  latinHref: string | null;
}

/** "Inter Variable" becomes "inter", "Sora Variable" becomes "sora". */
export function fileStem(family: string): string {
  const words = family
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word !== "");
  if (words.at(-1) === "variable") words.pop();
  return words.length === 0 ? "font" : words.join("-");
}

/** The family named by the last font-family declaration before offset. */
function familyAt(code: string, offset: number): string | null {
  const before = code.slice(Math.max(0, code.lastIndexOf("@font-face", offset)), offset);
  let family: string | null = null;
  for (const match of before.matchAll(FAMILY)) family = match[1] ?? null;
  return family === null ? null : unquote(family.trim());
}

function unquote(text: string): string {
  const first = text.charAt(0);
  const quoted = text.length >= 2 && (first === "'" || first === '"') && text.endsWith(first);
  return quoted ? text.slice(1, -1) : text;
}

/**
 * Moves each woff2 data: URI in code into its own content-hashed file named
 * after its font family, and finds the page font's Latin subset.
 */
export function externalize(code: string, base: string, pageFont: string): Externalized {
  const files: FontFile[] = [];
  let latinHref: string | null = null;
  const out = code.replace(DATA_FONT, (match, encoded: string, offset: number) => {
    const family = familyAt(code, offset);
    const source = Buffer.from(encoded, "base64");
    const hash = createHash("sha256").update(source).digest("hex").slice(0, 8);
    const fileName = `assets/${fileStem(family ?? "")}-${hash}.woff2`;
    files.push({ fileName, source });
    const href = `${base}${fileName}`;
    const after = code.slice(offset + match.length, offset + match.length + 400);
    const rest = after.slice(after.indexOf(")") + 1).replace(/\s/g, "");
    const latin = rest.slice(rest.indexOf("unicode-range")).startsWith(LATIN_RANGE);
    if (latin && family === pageFont) latinHref = href;
    return href;
  });
  return { code: out, files, latinHref };
}

/**
 * Oxygen UI embeds its fonts as base64 data: URIs inside its JavaScript: Inter,
 * which the WSO2 theme uses, and Sora, which only another of its themes uses.
 * This plugin moves each one into its own content-hashed .woff2 file named
 * after its family, so the JavaScript shrinks, the browser fetches only the
 * fonts and unicode ranges a page uses, and the files cache on their own. The
 * page font's Latin subset is preloaded; the build fails when it is missing.
 */
export function externalizeFonts(pageFont: string = PAGE_FONT): Plugin {
  let base = "/";
  let latinHref: string | null = null;
  return {
    name: "externalize-fonts",
    apply: "build",
    configResolved(config) {
      base = config.base;
    },
    renderChunk(code) {
      if (!code.includes("data:font/woff2;base64,")) return null;
      const result = externalize(code, base, pageFont);
      for (const file of result.files) this.emitFile({ type: "asset", ...file });
      latinHref = result.latinHref ?? latinHref;
      return result.code;
    },
    transformIndexHtml: {
      order: "post",
      handler() {
        if (latinHref === null) {
          throw new Error(
            `externalize-fonts: no Latin subset of "${pageFont}" in the bundle, so nothing to preload`,
          );
        }
        return [
          {
            tag: "link",
            attrs: {
              rel: "preload",
              as: "font",
              type: "font/woff2",
              crossorigin: "",
              href: latinHref,
            },
            injectTo: "head",
          },
        ];
      },
    },
  };
}
