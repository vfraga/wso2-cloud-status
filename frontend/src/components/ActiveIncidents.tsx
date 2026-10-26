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
import type { Incident, ProductSummary } from "../api/types";
import { usePageNow } from "../hooks/useNow";
import { lastKnownAt } from "../lib/dataNotes";
import { CARD_RADIUS } from "../theme/shape";
import { IncidentItem } from "./IncidentMeta";

interface ActiveIncidentsProps {
  incidents: readonly Incident[];
  products: ReadonlyMap<string, ProductSummary>;
  /** False on a product's own page, which already names the product and links its status page. */
  linked?: boolean;
  /** When the page's own data stopped (useKnownUntil); null while it is current. */
  knownUntil?: Date | null;
}

/**
 * Each incident names and links its product here and links the updates on
 * the product's own status page, unless `linked` is false.
 */
export function ActiveIncidents({
  incidents,
  products,
  linked = true,
  knownUntil = null,
}: ActiveIncidentsProps) {
  const now = usePageNow();
  if (incidents.length === 0) return null;
  return (
    <Box
      component="section"
      aria-labelledby="active-incidents"
      sx={{
        mt: { xs: 3, sm: 4 },
        px: { xs: 2.5, sm: 3 },
        pt: { xs: 1, sm: 1.5 },
        pb: { xs: 1.5, sm: 2 },
        bgcolor: "var(--cs-surface)",
        border: "1px solid var(--cs-border)",
        borderRadius: CARD_RADIUS,
      }}
    >
      <Typography
        id="active-incidents"
        component="h2"
        sx={{ fontSize: "1.125rem", fontWeight: 600, mt: 1.5, mb: 0.5 }}
      >
        Active incidents
      </Typography>
      <Box component="ul" sx={{ m: 0, p: 0 }}>
        {incidents.map((incident) => {
          const product = products.get(incident.productId);
          return (
            <IncidentItem
              key={incident.id}
              incident={incident}
              {...(linked ? { productName: product?.name ?? incident.productId } : {})}
              now={now}
              withDate
              titleAs="h3"
              lastKnownAt={lastKnownAt(incident, product, knownUntil)}
              {...(product && linked
                ? {
                    links: { productPath: `/products/${product.id}`, pageUrl: product.pageUrl },
                  }
                : {})}
            />
          );
        })}
      </Box>
    </Box>
  );
}
