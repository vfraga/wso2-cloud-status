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

const DATA_FONT = /data:font\/woff2;base64,([A-Za-z0-9+/=]+)/g;
const LATIN_RANGE = "unicode-range:U+0000-00FF";

/**
 * Oxygen UI embeds its Inter font as base64 data: URIs inside its JavaScript.
 * This plugin moves each one into its own content-hashed .woff2 file, so the
 * JavaScript shrinks, the browser fetches only the unicode ranges a page uses,
 * and the files cache on their own. The Latin subset is preloaded.
 */
export function externalizeFonts(): Plugin {
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
      return code.replace(DATA_FONT, (match, encoded: string, offset: number) => {
        const source = Buffer.from(encoded, "base64");
        const hash = createHash("sha256").update(source).digest("hex").slice(0, 8);
        const fileName = `assets/inter-${hash}.woff2`;
        this.emitFile({ type: "asset", fileName, source });
        const href = `${base}${fileName}`;
        const after = code.slice(offset + match.length, offset + match.length + 400);
        const rest = after.slice(after.indexOf(")") + 1).replace(/\s/g, "");
        if (rest.slice(rest.indexOf("unicode-range")).startsWith(LATIN_RANGE)) latinHref = href;
        return href;
      });
    },
    transformIndexHtml: {
      order: "post",
      handler() {
        if (latinHref === null) return [];
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
