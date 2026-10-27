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

import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join, relative, resolve } from "node:path";
import type { Plugin } from "vite";

/**
 * Removes an HTML file's comments and the whitespace that only lays out its
 * source, and from each inline stylesheet its comments and spacing. Text is
 * kept: only whitespace holding a line break between two tags goes.
 */
export function minifyHtml(html: string): string {
  return html
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/(<style[^>]*>)([^<]*)(<\/style>)/g, (_, open: string, css: string, close: string) => {
      return open + minifyCss(css) + close;
    })
    .replace(/>[ \t]*(?:\r?\n[ \t]*)+</g, "><")
    .trim();
}

/** Removes a stylesheet's comments and the spacing around its punctuation. */
export function minifyCss(css: string): string {
  return css
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\s+/g, " ")
    .replace(/ ?([{};,]) ?/g, "$1")
    .replace(/;}/g, "}")
    .trim();
}

function files(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    return entry.isDirectory() ? files(path) : [path];
  });
}

/**
 * What in a built file would show a reader the source: comments and source
 * maps, and in the app's own scripts a comment kept inside a string (a CSS
 * comment in a template literal, which no minifier removes). The vendor
 * chunk is third-party code and is checked for source maps only.
 */
const LEAKS: { what: string; files: RegExp; found: (text: string, name: string) => boolean }[] = [
  {
    what: "a source map reference",
    files: /\.(html|svg|xml|css|js|txt)$/,
    found: (t) => t.includes("sourceMappingURL"),
  },
  { what: "an HTML comment", files: /\.(html|svg|xml)$/, found: (t) => t.includes("<!--") },
  { what: "a CSS comment", files: /\.(html|svg|css)$/, found: (t) => t.includes("/*") },
  {
    what: "a comment inside a string",
    files: /\.js$/,
    found: (t, name) => !basename(name).startsWith("vendor-") && t.includes("/*"),
  },
];

/** Each built file that would show a reader the source, and what it shows. */
export function sourceLeaks(dir: string): string[] {
  return files(dir).flatMap((path) => {
    const name = relative(dir, path);
    if (name.endsWith(".map")) return [`${name}: a source map`];
    const rules = LEAKS.filter((rule) => rule.files.test(name));
    if (rules.length === 0) return [];
    const text = readFileSync(path, "utf8");
    return rules.filter((rule) => rule.found(text, name)).map((rule) => `${name}: ${rule.what}`);
  });
}

/**
 * Readers get the page without its source's comments: every built HTML file,
 * index.html and the error page copied from public/ alike, is minified, and
 * the build fails if a comment or a source map is left in what it ships.
 */
export function servedFiles(): Plugin {
  let outDir = "";
  return {
    name: "served-files",
    apply: "build",
    configResolved(config) {
      outDir = resolve(config.root, config.build.outDir);
    },
    closeBundle() {
      for (const path of files(outDir).filter((p) => p.endsWith(".html"))) {
        writeFileSync(path, minifyHtml(readFileSync(path, "utf8")));
      }
      const leaks = sourceLeaks(outDir);
      if (leaks.length > 0) {
        throw new Error(`the build would ship its source's comments:\n  ${leaks.join("\n  ")}`);
      }
    },
  };
}
