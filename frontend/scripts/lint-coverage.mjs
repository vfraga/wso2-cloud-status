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

// Fails when ESLint would skip a source file that Git tracks: one it ignores,
// or one that no entry of eslint.config.js matches. ESLint skips such a file
// without a word, so a change in its glob matching or in the configuration
// could narrow the lint unnoticed. ESLint's own API decides each path.
import { execFileSync } from "node:child_process";
import { ESLint } from "eslint";

const SOURCE = /\.(?:[cm]?[jt]s|[jt]sx)$/;

const eslint = new ESLint();

/** The given paths ESLint would not lint. */
async function skipped(paths) {
  const out = [];
  for (const path of paths) {
    if ((await eslint.isPathIgnored(path)) || !(await eslint.calculateConfigForFile(path))) {
      out.push(path);
    }
  }
  return out;
}

// The check proves it can fail: a file in the build output must read as skipped.
if ((await skipped(["dist/lint-coverage-probe.ts"])).length !== 1) {
  console.error("lint-coverage: ESLint would lint dist/, so this check cannot tell a skipped file");
  process.exit(1);
}

// Git by its absolute path, not looked up in PATH, which another directory could shadow.
const tracked = execFileSync("/usr/bin/git", ["ls-files", "-z", "--", "."], { encoding: "utf8" })
  .split("\0")
  .filter((path) => SOURCE.test(path));
if (tracked.length === 0) {
  console.error("lint-coverage: Git lists no source files here");
  process.exit(1);
}

const missed = await skipped(tracked);
if (missed.length > 0) {
  console.error(`lint-coverage: ESLint would skip ${missed.length} tracked source file(s):`);
  for (const path of missed) console.error(`  ${path}`);
  process.exit(1);
}
console.log(`lint-coverage: ESLint lints all ${tracked.length} tracked source files`);
