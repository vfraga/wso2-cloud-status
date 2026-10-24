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
import type { Location, ProductSummary, RegionSummary } from "../api/types";
import { useAutoExpanded } from "../hooks/useAutoExpanded";
import { productRows, rowStatus, shortName } from "../lib/regions";
import { STATUS_LABEL, count, isProblem } from "../lib/status";
import { ExternalAnchor } from "./ExternalAnchor";
import { StatusLabel } from "./StatusIcon";
import { UptimeFigure } from "./UptimeList";

const rowSx = {
  justifyContent: "space-between",
  alignItems: "center",
  flexWrap: "wrap",
  gap: 1,
  py: 1,
  borderTop: "1px solid var(--cs-border)",
} as const;

const listSx = { listStyle: "none", m: 0, p: 0, pl: 2 } as const;

/** Fits "Degraded performance", the longest status label, with its icon. */
const STATUS_COLUMN = "12.5rem";

/** A text button with a chevron that opens and closes the panel it controls. */
function Disclosure({
  expanded,
  panelId,
  onToggle,
  children,
}: {
  expanded: boolean;
  panelId: string;
  onToggle: () => void;
  children: ReactNode;
}) {
  return (
    <Button
      variant="text"
      size="small"
      aria-expanded={expanded}
      // The panel unmounts when collapsed; point at it only while it exists.
      aria-controls={expanded ? panelId : undefined}
      onClick={onToggle}
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
      {children}
    </Button>
  );
}

/** A region on its own, or a part of a location: its name, 90-day uptime, status and own page. */
function RegionItem({
  product,
  region,
  name,
}: {
  product: ProductSummary;
  region: RegionSummary;
  name: string;
}) {
  return (
    <Stack component="li" direction="row" useFlexGap sx={rowSx}>
      {/* On a phone the name has its own line and the status leads the next, as in a product row. */}
      <Typography variant="body2" sx={{ fontWeight: 500, flexBasis: { xs: "100%", sm: "auto" } }}>
        {name}
      </Typography>
      <Stack
        direction="row"
        useFlexGap
        sx={{
          alignItems: "center",
          flexWrap: "wrap",
          justifyContent: { xs: "flex-start", sm: "flex-end" },
          columnGap: 2,
          rowGap: 0.5,
        }}
      >
        {region.pageUrl !== "" && region.pageUrl !== product.pageUrl && (
          <Box sx={{ order: { xs: 3, sm: 0 } }}>
            <ExternalAnchor
              href={region.pageUrl}
              label={`Status page for ${region.name}, ${product.name}`}
            >
              Status page
            </ExternalAnchor>
          </Box>
        )}
        <UptimeFigure uptime={region.uptime} order={{ xs: 2, sm: 0 }} />
        {/* On a wider screen, a status column as wide as the longest label, so the figures line up. */}
        <Box
          sx={{
            order: { xs: 1, sm: 0 },
            display: "flex",
            justifyContent: "flex-end",
            minWidth: { sm: STATUS_COLUMN },
          }}
        >
          <StatusLabel status={region.status}>{STATUS_LABEL[region.status]}</StatusLabel>
        </Box>
      </Stack>
    </Stack>
  );
}

/**
 * A location (US) that opens into its parts (control plane, data plane).
 * Open by default when a part has a problem or differs from the location.
 */
function LocationItem({
  product,
  location,
  regions,
}: {
  product: ProductSummary;
  location: Location;
  regions: readonly RegionSummary[];
}) {
  const [expanded, setExpanded] = useAutoExpanded(
    isProblem(location.status) || regions.some((r) => r.status !== location.status),
  );
  const panelId = useId();
  return (
    <Box component="li" sx={{ borderTop: "1px solid var(--cs-border)", py: 0.5 }}>
      <Stack direction="row" useFlexGap sx={{ ...rowSx, borderTop: 0, py: 0.5 }}>
        <Disclosure
          expanded={expanded}
          panelId={panelId}
          onToggle={() => {
            setExpanded(!expanded);
          }}
        >
          {location.name}
        </Disclosure>
        <StatusLabel status={location.status}>{STATUS_LABEL[location.status]}</StatusLabel>
      </Stack>
      <Collapse in={expanded} id={panelId} unmountOnExit>
        <Box component="ul" sx={listSx}>
          {regions.map((region) => (
            <RegionItem
              key={region.id}
              product={product}
              region={region}
              name={shortName(region, location)}
            />
          ))}
        </Box>
      </Collapse>
    </Box>
  );
}

/**
 * Open by default when the regions add something to the row's own status: a
 * problem, or regions that differ from the product (some known, some not).
 * A product whose every region repeats "Status unavailable" stays closed.
 * The user can always toggle.
 */
export function Regions({ product, trailing }: { product: ProductSummary; trailing: ReactNode }) {
  const rows = productRows(product);
  const needsAttention =
    isProblem(product.status) || rows.some((row) => rowStatus(row) !== product.status);
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
        {rows.length > 0 ? (
          <Disclosure
            expanded={expanded}
            panelId={panelId}
            onToggle={() => {
              setExpanded(!expanded);
            }}
          >
            {count(rows.length, "region")}
          </Disclosure>
        ) : (
          <span />
        )}
        {trailing}
      </Stack>
      <Collapse in={expanded} id={panelId} unmountOnExit>
        <Box component="ul" sx={{ ...listSx, mt: 1 }}>
          {rows.map((row) =>
            row.kind === "location" ? (
              <LocationItem
                key={`location-${row.location.id}`}
                product={product}
                location={row.location}
                regions={row.regions}
              />
            ) : (
              <RegionItem
                key={row.region.id}
                product={product}
                region={row.region}
                name={row.region.name}
              />
            ),
          )}
        </Box>
      </Collapse>
    </>
  );
}
