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

import { Box, Typography } from "@wso2/oxygen-ui";
import { FALLBACK_PRODUCTS } from "../lib/fallbackProducts";
import { ExternalAnchor } from "./ExternalAnchor";

/**
 * Shown in place of the products when the status API has not answered since
 * the page loaded, or its summary listed no products: a route to every
 * product's own status page that does not depend on the API.
 */
export function FallbackLinks() {
  return (
    <Box sx={{ p: 2.5 }}>
      <Typography>
        Product status is not available right now. Check each product&apos;s own status page:
      </Typography>
      <Box component="ul" sx={{ m: 0, mt: 1, pl: 2.5 }}>
        {FALLBACK_PRODUCTS.map((p) => (
          <li key={p.id}>
            <ExternalAnchor href={p.pageUrl} label={`${p.name} status page`}>
              {p.name} status page
            </ExternalAnchor>
          </li>
        ))}
      </Box>
    </Box>
  );
}
