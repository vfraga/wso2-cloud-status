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
import { readFileSync } from "node:fs";
import { defineConfig } from "vite";
import { externalizeFonts } from "./build/externalize-fonts.ts";
import { servedFiles } from "./build/served-files.ts";
import { stubAliases } from "./build/stubs.ts";

const proxy = {
  "/api": {
    target: process.env["API_PROXY_TARGET"] ?? "http://localhost:8080",
    changeOrigin: true,
  },
};

/**
 * The Content-Security-Policy the image sends (docker/nginx.conf). vite preview
 * sends it too, so the end-to-end tests run the build under the production
 * policy and a violation shows as a console error.
 */
const csp = /set \$csp "([^"]+)";/.exec(
  readFileSync(new URL("./docker/nginx.conf", import.meta.url), "utf8"),
)?.[1];
if (csp === undefined) throw new Error("docker/nginx.conf sets no $csp");

export default defineConfig({
  plugins: [react(), externalizeFonts(), servedFiles()],
  resolve: { alias: stubAliases },
  server: { proxy },
  preview: { proxy, headers: { "Content-Security-Policy": csp } },
  build: {
    sourcemap: false,
    chunkSizeWarningLimit: 700,
    rolldownOptions: {
      output: {
        // App code stays small and changes often; React, MUI and Oxygen change rarely.
        codeSplitting: { groups: [{ name: "vendor", test: /node_modules/ }] },
      },
    },
  },
});
