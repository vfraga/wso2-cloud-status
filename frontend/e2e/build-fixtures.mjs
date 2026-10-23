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

// Usage: node e2e/build-fixtures.mjs <scenario> <outDir>
// Builds one scenario's upstream fixture directory (see e2e/fixtures/README.txt).
import { cp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

const [scenario, outDir] = process.argv.slice(2);
if (!scenario || !outDir) throw new Error("usage: build-fixtures.mjs <scenario> <outDir>");

const here = new URL(".", import.meta.url).pathname;
const base = resolve(here, "../../testdata/upstream");
const overlay = join(here, "fixtures", scenario);

const UNITS = { m: 60_000, h: 3_600_000, d: 86_400_000 };

function instant(spec) {
  const match = /^(\d+)([mhd])$/.exec(spec);
  if (!match) throw new Error(`bad time spec ${spec}`);
  return new Date(Date.now() - Number(match[1]) * UNITS[match[2]]);
}

const pad = (n) => String(n).padStart(2, "0");

function expand(text) {
  return text
    .replace(/@@month:ago:(\w+)@@/g, (_, spec) => {
      const d = instant(spec);
      return `${String(d.getUTCFullYear())}-${String(d.getUTCMonth() + 1)}`;
    })
    .replace(/@@ago:(\w+)@@/g, (_, spec) => {
      const d = instant(spec);
      return `${String(d.getUTCFullYear())}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
    });
}

await rm(outDir, { recursive: true, force: true });
await mkdir(outDir, { recursive: true });
await cp(base, outDir, { recursive: true });

let entries = [];
try {
  entries = await readdir(overlay);
} catch {
  // The base scenario has no overlay.
}
for (const name of entries) {
  const text = await readFile(join(overlay, name), "utf8");
  if (name === "REMOVE") {
    for (const file of text.split("\n").filter(Boolean))
      await rm(join(outDir, file), { force: true });
  } else if (name.endsWith(".json")) {
    await writeFile(join(outDir, name), expand(text));
  }
}
