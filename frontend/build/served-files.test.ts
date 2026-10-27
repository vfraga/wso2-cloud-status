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

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { minifyHtml, sourceLeaks } from "./served-files.ts";

describe("minifyHtml", () => {
  it("drops comments and layout whitespace, keeps text and its spaces", () => {
    const html = `<!doctype html>
<html lang="en">
  <head>
    <!-- a note for maintainers -->
    <style>
      /* why */
      .a {
        padding: 15vh 16px 16px;
        font-family: a, b;
      }
    </style>
  </head>
  <body>
    <p>Reload the <strong>page</strong> in a moment.</p>
  </body>
</html>
`;
    expect(minifyHtml(html)).toBe(
      '<!doctype html><html lang="en"><head><style>.a{padding: 15vh 16px 16px;font-family: a,b}</style>' +
        "</head><body><p>Reload the <strong>page</strong> in a moment.</p></body></html>",
    );
  });

  it("minifies the page's own index.html without a comment left", () => {
    const html = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), "..", "index.html"),
      "utf8",
    );
    const min = minifyHtml(html);
    expect(min).not.toContain("<!--");
    expect(min).not.toContain("/*");
    expect(min).toContain("If the current status does not appear, reload the page in a moment.");
  });
});

describe("sourceLeaks", () => {
  let dir = "";
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("names comments and source maps in what the build ships", () => {
    dir = mkdtempSync(join(tmpdir(), "served-"));
    mkdirSync(join(dir, "assets"));
    writeFileSync(join(dir, "index.html"), "<p>ok</p><!-- note -->");
    writeFileSync(join(dir, "assets", "index-1.js"), "const css=`a{} /* why */`;");
    writeFileSync(join(dir, "assets", "vendor-1.js"), "const glob=`./dist/*.js`;");
    writeFileSync(join(dir, "assets", "index-1.js.map"), "{}");
    writeFileSync(join(dir, "error.html"), "<p>clean</p>");
    expect(new Set(sourceLeaks(dir))).toEqual(
      new Set([
        "assets/index-1.js.map: a source map",
        "assets/index-1.js: a comment inside a string",
        "index.html: an HTML comment",
      ]),
    );
  });
});
