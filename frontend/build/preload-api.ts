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

import type { Plugin } from "vite";
import { apiBase, INCIDENTS_PATH, SUMMARY_PATH } from "../src/api/endpoints.ts";

/**
 * Starts the home page's API requests with the HTML instead of after its
 * scripts have loaded and run: a preload for the summary and the incident
 * list, which the first poll of each takes. On another page they go unused,
 * a few kilobytes and a console warning.
 */
export function preloadApi(): Plugin {
  let base = "";
  return {
    name: "preload-api",
    apply: "build",
    configResolved(config) {
      base = apiBase(config.env.VITE_API_BASE_URL as string | undefined);
    },
    transformIndexHtml: {
      order: "post",
      handler() {
        return [SUMMARY_PATH, INCIDENTS_PATH].map((path) => ({
          tag: "link",
          attrs: { rel: "preload", as: "fetch", crossorigin: "anonymous", href: `${base}${path}` },
          injectTo: "head" as const,
        }));
      },
    },
  };
}
