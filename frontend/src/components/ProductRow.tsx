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

import { Box, Stack, Typography } from "@wso2/oxygen-ui";
import type { Incident, ProductSummary } from "../api/types";
import { completeUntil } from "../lib/dataNotes";
import { missingDataText } from "../lib/headline";
import { Link } from "../lib/router";
import { PARTIAL_LABEL, STATUS_LABEL, capitalise, regionsAffected } from "../lib/status";
import { earliest } from "../lib/time";
import { ExternalAnchor } from "./ExternalAnchor";
import { HistoryStrip } from "./HistoryStrip";
import { ProductNotes } from "./ProductNotes";
import { Regions } from "./Regions";
import { StatusLabel } from "./StatusIcon";

interface ProductRowProps {
  product: ProductSummary;
  incidents: ReadonlyMap<string, Incident>;
  /** When the page's own data stopped (useKnownUntil); null while it is current. */
  knownUntil?: Date | null;
}

const captionSx = { display: "block", color: "var(--cs-muted)" } as const;

/** An operational product with missing data is not shown as green "Operational". */
function RowStatus({ product }: { product: ProductSummary }) {
  const partial = product.status === "operational" && !product.dataComplete;
  return partial ? (
    <StatusLabel status="unknown">{PARTIAL_LABEL}</StatusLabel>
  ) : (
    <StatusLabel status={product.status}>{STATUS_LABEL[product.status]}</StatusLabel>
  );
}

export function ProductRow({ product, incidents, knownUntil = null }: ProductRowProps) {
  const total = product.regions.length;
  return (
    <Box component="li" sx={{ listStyle: "none", px: { xs: 2.5, sm: 3 }, py: { xs: 2.5, sm: 3 } }}>
      <Stack
        direction="row"
        useFlexGap
        sx={{ justifyContent: "space-between", alignItems: "flex-start", flexWrap: "wrap", gap: 1 }}
      >
        <Box sx={{ minWidth: 0 }}>
          <Typography
            component="h2"
            sx={{ fontSize: "1.125rem", fontWeight: 600, lineHeight: 1.3 }}
          >
            <Link to={`/products/${product.id}`} style={{ textDecoration: "none" }}>
              {product.name}
            </Link>
          </Typography>
          {product.description !== undefined && (
            <Typography variant="body2" sx={{ color: "var(--cs-muted)" }}>
              {product.description}
            </Typography>
          )}
        </Box>
        <Box sx={{ textAlign: { xs: "left", sm: "right" } }}>
          <div>
            <RowStatus product={product} />
          </div>
          {product.affectedRegions > 0 && (
            <Typography variant="caption" sx={captionSx}>
              {regionsAffected(product.affectedRegions, total)}
            </Typography>
          )}
          {product.status !== "unknown" && !product.dataComplete && (
            <Typography variant="caption" sx={captionSx}>
              {capitalise(missingDataText(product))}
            </Typography>
          )}
          <ProductNotes
            product={product}
            // The home page has incidents at hand, and shows no uptime.
            partly={{
              incidents: [...incidents.values()].some((i) => i.productId === product.id),
              uptime: false,
            }}
            uptime={false}
            alignEnd
          />
        </Box>
      </Stack>
      <HistoryStrip
        productName={product.name}
        days={product.history}
        incidents={incidents}
        completeUntil={earliest(completeUntil(product), knownUntil)}
      />
      <Regions
        product={product}
        trailing={
          <ExternalAnchor
            href={product.pageUrl}
            label={`View status page for ${product.name}`}
            weight={500}
          >
            View status page
          </ExternalAnchor>
        }
      />
    </Box>
  );
}
