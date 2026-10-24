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

// Renders the bitmap icons from public/icon.svg, the WSO2 pulse glyph from the
// brand pack cropped to its drawing. Run it after changing that file:
//
//   node scripts/icons.mjs
//
// favicon.ico holds the orange glyph at 32 px; apple-touch-icon.png (180 px,
// the home-screen icon) the white glyph on the brand's navy, at 60% of the
// tile.
import { chromium } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";

const pub = path.resolve(import.meta.dirname, "../public");
const svg = fs.readFileSync(path.join(pub, "icon.svg"), "utf8");
const NAVY = "#17223a";

const sized = (source, px) =>
  source.replace("<svg ", `<svg width="${String(px)}" height="${String(px)}" `);
const glyph = (px) => sized(svg, px);
const tile = (px) =>
  `<div style="width:${String(px)}px;height:${String(px)}px;background:${NAVY};display:grid;place-items:center">` +
  `${sized(svg.replaceAll('fill="#f14e23"', 'fill="#ffffff"'), Math.round(px * 0.6))}</div>`;

/** An ICO file holding one PNG image, which every current browser reads. */
function ico(png) {
  const head = Buffer.alloc(22);
  head.writeUInt16LE(1, 2); // type: icon
  head.writeUInt16LE(1, 4); // one image
  head.writeUInt8(png.readUInt32BE(16), 6); // width, from the PNG header
  head.writeUInt8(png.readUInt32BE(20), 7); // height
  head.writeUInt16LE(1, 10); // colour planes
  head.writeUInt16LE(32, 12); // bits per pixel
  head.writeUInt32LE(png.length, 14);
  head.writeUInt32LE(head.length, 18); // where the image starts
  return Buffer.concat([head, png]);
}

const browser = await chromium.launch();
const page = await browser.newPage();
async function render(px, html) {
  await page.setViewportSize({ width: px, height: px });
  await page.setContent(
    `<!doctype html><style>html,body{margin:0}svg{display:block}</style>${html}`,
  );
  return page.screenshot({ omitBackground: true, clip: { x: 0, y: 0, width: px, height: px } });
}
fs.writeFileSync(path.join(pub, "favicon.ico"), ico(await render(32, glyph(32))));
fs.writeFileSync(path.join(pub, "apple-touch-icon.png"), await render(180, tile(180)));
await browser.close();
