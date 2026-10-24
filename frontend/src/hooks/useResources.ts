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

import { parseIncidentList, parseProductDetail, parseSummary } from "../api/parse";
import { config } from "../config";
import { usePolled } from "./usePolled";

export const useSummary = () =>
  usePolled("/api/v1/summary", parseSummary, config.summaryIntervalMs);

/** `activeKey` names the summary's active incidents: when it changes, the list is fetched at once. */
export const useIncidents = (activeKey: string | null = null) =>
  usePolled("/api/v1/incidents", parseIncidentList, config.incidentsIntervalMs, activeKey);

export const useProduct = (id: string) =>
  usePolled(
    `/api/v1/products/${encodeURIComponent(id)}`,
    parseProductDetail,
    config.productIntervalMs,
  );
