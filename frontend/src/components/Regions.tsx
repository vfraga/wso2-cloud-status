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

import { Box, Button, Collapse, Stack, Typography } from "@wso2/oxygen-ui";
import { ChevronDown } from "@wso2/oxygen-ui-icons-react";
import { useId, type ReactNode } from "react";
import type { ProductSummary } from "../api/types";
import { useAutoExpanded } from "../hooks/useAutoExpanded";
import { STATUS_LABEL, isProblem } from "../lib/status";
import { ExternalAnchor } from "./ExternalAnchor";
import { StatusLabel } from "./StatusIcon";

/**
 * Open by default when the regions add something to the row's own status: a
 * problem, or regions that differ from the product (some known, some not).
 * A product whose every region repeats "Status unavailable" stays closed.
 * The user can always toggle.
 */
export function Regions({ product, trailing }: { product: ProductSummary; trailing: ReactNode }) {
  const needsAttention =
    isProblem(product.status) || product.regions.some((r) => r.status !== product.status);
  const [expanded, setExpanded] = useAutoExpanded(needsAttention);
  const panelId = useId();

  return (
    <>
      <Stack
        direction="row"
        useFlexGap
        sx={{
          justifyContent: "space-between",
          alignItems: "center",
          flexWrap: "wrap",
          gap: 1,
          mt: 1.5,
        }}
      >
        {product.regions.length > 0 ? (
          <Button
            variant="text"
            size="small"
            aria-expanded={expanded}
            // The panel unmounts when collapsed; point at it only while it exists.
            aria-controls={expanded ? panelId : undefined}
            onClick={() => {
              setExpanded(!expanded);
            }}
            endIcon={
              <ChevronDown
                aria-hidden="true"
                size={16}
                style={{
                  transform: expanded ? "rotate(180deg)" : "none",
                  transition: "transform 150ms",
                }}
              />
            }
            sx={{
              color: "var(--cs-text)",
              minWidth: 0,
              px: 0,
              py: 0.5,
              textTransform: "none",
              fontWeight: 600,
              "&:hover": { bgcolor: "transparent", textDecoration: "underline" },
            }}
          >
            {product.regions.length === 1
              ? "1 region"
              : `${String(product.regions.length)} regions`}
          </Button>
        ) : (
          <span />
        )}
        {trailing}
      </Stack>
      <Collapse in={expanded} id={panelId} unmountOnExit>
        <Box component="ul" sx={{ listStyle: "none", m: 0, mt: 1, p: 0, pl: 2 }}>
          {product.regions.map((region) => (
            <Stack
              key={region.id}
              component="li"
              direction="row"
              useFlexGap
              sx={{
                justifyContent: "space-between",
                alignItems: "center",
                flexWrap: "wrap",
                gap: 1,
                py: 1,
                borderTop: "1px solid var(--cs-border)",
              }}
            >
              <Typography variant="body2" sx={{ fontWeight: 500 }}>
                {region.name}
              </Typography>
              <Stack direction="row" useFlexGap sx={{ alignItems: "center", gap: 2 }}>
                <StatusLabel status={region.status}>{STATUS_LABEL[region.status]}</StatusLabel>
                {region.pageUrl !== "" && region.pageUrl !== product.pageUrl && (
                  <ExternalAnchor
                    href={region.pageUrl}
                    label={`Status page for ${region.name}, ${product.name}`}
                  >
                    Status page
                  </ExternalAnchor>
                )}
              </Stack>
            </Stack>
          ))}
        </Box>
      </Collapse>
    </>
  );
}
