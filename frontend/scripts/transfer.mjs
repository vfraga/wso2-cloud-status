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

// Usage: node scripts/transfer.mjs <url>
// Lists what the page requests on first load and the gzip transfer size of each file.
import { gzipSync } from "node:zlib";
import { chromium } from "@playwright/test";

const url = process.argv[2];
if (!url) throw new Error("usage: transfer.mjs <url>");
const browser = await chromium.launch();
const page = await browser.newPage();
const sizes = [];
page.on("response", async (r) => {
  const u = new URL(r.url());
  if (u.pathname.startsWith("/api/")) return;
  const body = await r.body().catch(() => Buffer.alloc(0));
  const type = r.headers()["content-type"] ?? "";
  const gz = /font|woff/.test(type) ? body.length : gzipSync(body, { level: 9 }).length;
  sizes.push([u.pathname, body.length, gz]);
});
await page.goto(url, { waitUntil: "networkidle" });
let total = 0;
for (const [p, raw, gz] of sizes) {
  total += gz;
  console.log(String(gz).padStart(8), String(raw).padStart(8), p);
}
console.log(String(total).padStart(8), "total (gzip for text, raw for fonts)");
await browser.close();
