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

/**
 * Every product's id and name, built into the page: a product page can name
 * its product, and tell an unknown id from a failing API, before the status
 * API answers. Keep it in step with the products in config/statusd.yaml, in
 * the same order: fallbackProducts.test.ts fails when an id or name differs.
 */
export interface FallbackProduct {
  id: string;
  name: string;
}

export const FALLBACK_PRODUCTS: readonly FallbackProduct[] = [
  { id: "agent-platform", name: "Agent Platform" },
  { id: "api-platform", name: "API Platform" },
  { id: "integration-platform", name: "Integration Platform" },
  { id: "identity-platform", name: "Identity Platform" },
  { id: "developer-platform", name: "Developer Platform" },
  { id: "moesif", name: "Moesif" },
];

/**
 * Each product's privacy policy and terms of use, as its own status page
 * links them (the final address after redirects, checked 2026-10-26). Four
 * products use WSO2's privacy policy. A product's page shows them in its
 * footer; fallbackProducts.test.ts fails when a product has none.
 */
export const PRODUCT_LEGAL: Readonly<Record<string, { privacy: string; terms: string }>> = {
  "agent-platform": {
    privacy: "https://wso2.com/privacy-policy",
    terms: "https://wso2.com/cloud/agent-manager/terms-of-use",
  },
  "api-platform": {
    privacy: "https://wso2.com/privacy-policy",
    terms: "https://wso2.com/api-platform/terms-of-use/",
  },
  "integration-platform": {
    privacy: "https://wso2.com/privacy-policy",
    terms: "https://wso2.com/integration-platform/terms-of-use/",
  },
  "identity-platform": {
    privacy: "https://wso2.com/privacy-policy",
    terms: "https://wso2.com/identity-platform/terms-of-use/",
  },
  "developer-platform": {
    privacy: "https://wso2.com/engineering-platform/developer-platform/privacy-policy/",
    terms: "https://wso2.com/engineering-platform/developer-platform/terms-of-use/",
  },
  moesif: {
    privacy: "https://www.moesif.com/privacy",
    terms: "https://www.moesif.com/terms",
  },
};

/** Products the summary has listed in this page's lifetime, by id. */
const listed = new Map<string, FallbackProduct>();

/** Records the products a summary listed, so a product page can recognise them later. */
export function rememberProducts(products: readonly FallbackProduct[]): void {
  for (const { id, name } of products) listed.set(id, { id, name });
}

/**
 * The product with this id from the catalogue: what the summary listed in
 * this page's lifetime, else the list built into the page. Undefined only for
 * an id neither knows, which is the one case "We could not find that
 * product" is true; any other failure is the API's.
 */
export function knownProduct(id: string): FallbackProduct | undefined {
  return listed.get(id) ?? FALLBACK_PRODUCTS.find((p) => p.id === id);
}

/** Forgets what the summary listed; for tests, which share one module between pages. */
export function forgetListedProducts(): void {
  listed.clear();
}
