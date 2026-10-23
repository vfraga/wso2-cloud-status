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

import { defineConfig, devices } from "@playwright/test";

// scripts/e2e.sh starts the real backend and the built site, then sets E2E_BASE_URL,
// and E2E_TZ for a scenario it runs in another time zone. Contexts a spec opens
// itself with browser.newContext() do not get these settings.
export default defineConfig({
  testDir: "e2e/specs",
  fullyParallel: false,
  workers: 1,
  forbidOnly: true,
  retries: 0,
  // The phone axe tests scan four pages each, about 30 s on a slow or emulated runner.
  timeout: 60_000,
  reporter: [["list"]],
  outputDir: "test-results",
  use: {
    ...devices["Desktop Chrome"],
    baseURL: process.env["E2E_BASE_URL"] ?? "http://127.0.0.1:18193",
    locale: "en-US",
    timezoneId: process.env["E2E_TZ"] ?? "UTC",
    trace: "retain-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
