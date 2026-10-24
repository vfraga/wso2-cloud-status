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

import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";
import { stubAliases } from "./build/stubs.ts";

// Dates render in the viewer's zone; tests pin it so output is deterministic.
// `npm test` runs once more in zones east and west of UTC (VITEST_TZ).
process.env["TZ"] = process.env["VITEST_TZ"] ?? "UTC";

export default defineConfig({
  plugins: [react()],
  resolve: { alias: stubAliases },
  test: {
    environment: "jsdom",
    // A cold first render of the whole app can pass the 5 s default on a busy machine.
    testTimeout: 20_000,
    hookTimeout: 20_000,
    setupFiles: ["./src/test/setup.ts"],
    include: ["src/**/*.test.{ts,tsx}"],
    env: { VITE_API_BASE_URL: "http://api.test" },
    css: { include: [] },
    server: { deps: { inline: [/@wso2\/oxygen-ui/] } },
    coverage: {
      provider: "v8",
      include: ["src/**/*.{ts,tsx}"],
      exclude: [
        "src/main.tsx",
        "src/stubs/**",
        "src/test/**",
        "src/**/*.test.*",
        "src/vite-env.d.ts",
      ],
      reporter: ["text", "html", "json-summary"],
      thresholds: { lines: 85, statements: 85, functions: 85, branches: 80 },
    },
  },
});
