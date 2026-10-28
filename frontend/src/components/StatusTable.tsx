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

import { Box, Skeleton, Typography } from "@wso2/oxygen-ui";
import { ChevronRight } from "@wso2/oxygen-ui-icons-react";
import { memo, useId, type MouseEvent } from "react";
import type { ProductSummary, Status } from "../api/types";
import { FALLBACK_PRODUCTS } from "../lib/fallbackProducts";
import { type PlaceStatus, placeNames, placeStatus, productRows } from "../lib/regions";
import { Link, navigate } from "../lib/router";
import {
  PRODUCT_COLUMN,
  STATUS_COLUMN,
  STATUS_LABEL,
  STATUS_RANK,
  STATUS_TABLE_CAPTION,
  isProblem,
  noRegionIn,
  partStatus,
  regionNotStated,
  rolledUp,
} from "../lib/status";
import { StatusIcon, StatusLabel } from "./StatusIcon";

/*
 * A table from sm up. On a phone each row wraps instead: the product's name
 * across the top, then its places side by side while they fit, each with
 * its name in front ("US", "EU"). The column headers are then visually
 * hidden but still read. CSS that changes a table's display can drop its
 * semantics in some browsers, so every element also states its role.
 */

/** Below MUI's sm breakpoint. */
const PHONE = "@media (max-width: 599.95px)";
const hiddenOnPhone = {
  [PHONE]: {
    position: "absolute",
    width: "1px",
    height: "1px",
    overflow: "hidden",
    clip: "rect(0 0 0 0)",
    whiteSpace: "nowrap",
  },
} as const;
const cellSx = {
  display: { xs: "block", sm: "table-cell" },
  // 12 px on a phone keeps two places side by side from 360 px.
  px: { xs: 1.5, sm: 3 },
  py: 2,
  textAlign: "left",
  verticalAlign: "top",
  fontWeight: "inherit",
} as const;
const headSx = {
  ...cellSx,
  py: 1.25,
  fontSize: "0.8125rem",
  fontWeight: 600,
  color: "var(--cs-muted)",
} as const;
/** The product's name and the name customers knew it by, one line each. */
const nameSx = { fontSize: "1.0625rem", fontWeight: 600, lineHeight: 1.4 } as const;
/** Fits "Degraded performance", the longest status label, with its icon. */
const PLACE_COLUMN = "13rem";
/** The width of the label's icon; a part's smaller icon is centred in it, so names line up with the status text. */
const ICON_BOX = "16px";

/**
 * A part under its place's status: its own status as an icon, then its name.
 * The banner above gives each status in words; here it is in text too, for assistive technology.
 */
function PartLine({ name, status }: { name: string; status: Status }) {
  return (
    <Typography
      variant="caption"
      sx={{ display: "flex", alignItems: "flex-start", gap: 0.75, color: "var(--cs-muted)" }}
    >
      {/* Centred on the caption's first line, as long names wrap. */}
      <Box
        component="span"
        sx={{ display: "inline-flex", justifyContent: "center", width: ICON_BOX, mt: "3px" }}
      >
        <StatusIcon status={status} size={14} />
      </Box>
      <span aria-hidden="true">{name}</span>
      <span className="cs-visually-hidden">{partStatus(name, status)}</span>
    </Typography>
  );
}

/** A location rolls up its planes; a region that is a place itself keeps its own words. */
function placeLabel(at: PlaceStatus): { status: Status; label: string } {
  return at.extent === undefined
    ? { status: at.status, label: STATUS_LABEL[at.status] }
    : rolledUp(at.status, at.extent);
}

function StatusCell({ product, place }: { product: ProductSummary; place: string }) {
  const at = placeStatus(product, place);
  const shown = at === undefined ? undefined : { ...at, ...placeLabel(at) };
  return (
    <Box
      component="td"
      role="cell"
      sx={{
        ...cellSx,
        pt: { xs: 0, sm: 2 },
        // Whole words: a place's width, set by its longest word, decides when places stack.
        overflowWrap: "break-word",
        [PHONE]: { flex: "1 1 0" },
      }}
    >
      <Box sx={{ display: "flex", alignItems: "flex-start", gap: 1 }}>
        {/* A screen reader takes the place from the column header; on a phone, where the header is hidden, the eye needs it here. */}
        <Typography
          component="span"
          variant="body2"
          aria-hidden="true"
          sx={{
            display: { xs: "block", sm: "none" },
            minWidth: "1.75rem",
            // A region the configuration does not name shows the upstream's key here.
            overflowWrap: "anywhere",
            fontWeight: 600,
            color: "var(--cs-muted)",
          }}
        >
          {place}
        </Typography>
        {shown === undefined ? (
          <>
            <Typography
              component="span"
              variant="body2"
              aria-hidden="true"
              sx={{ color: "var(--cs-muted)" }}
            >
              -
            </Typography>
            <span className="cs-visually-hidden">{noRegionIn(place)}</span>
          </>
        ) : (
          <Box sx={{ minWidth: 0 }}>
            <StatusLabel status={shown.status}>{shown.label}</StatusLabel>
            {shown.parts.map((part) => (
              <PartLine key={part.name} name={part.name} status={part.status} />
            ))}
          </Box>
        )}
      </Box>
    </Box>
  );
}

function ProductStatusRow({
  product,
  places,
}: {
  product: ProductSummary;
  places: readonly string[];
}) {
  const path = `/products/${product.id}`;
  // The whole row opens the product, a larger target than its name. The name
  // stays the link, for the keyboard, screen readers and a new tab.
  const open = (event: MouseEvent<HTMLTableRowElement>): void => {
    if (event.defaultPrevented || event.button !== 0) return;
    // A modified click asks for another tab or window (the name's link opens one); this tab stays.
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    if (window.getSelection()?.toString()) return;
    navigate(path);
  };
  // A product with no regions at all is not "not in" every place: its own status spans them.
  const own = places.length === 0 || productRows(product).length === 0;
  // An active incident that names no region raises the product above every
  // place; the row says so under the name, or it would read all clear.
  const unplaced =
    !own &&
    isProblem(product.status) &&
    places.every(
      (place) =>
        STATUS_RANK[product.status] > STATUS_RANK[placeStatus(product, place)?.status ?? "unknown"],
    );
  const columns = Math.max(places.length, 1);
  return (
    <Box
      component="tr"
      role="row"
      onClick={open}
      sx={{
        // Places side by side while they fit, one under the other when the
        // screen is narrow or text is spaced out (WCAG 1.4.10, 1.4.12).
        display: { xs: "flex", sm: "table-row" },
        flexWrap: "wrap",
        borderTop: "1px solid var(--cs-border)",
        // On a phone the header row is hidden, so the first row needs no line above it.
        [PHONE]: { "&:first-of-type": { borderTop: 0 } },
        cursor: "pointer",
        "&:hover": { bgcolor: "var(--cs-page)" },
      }}
    >
      <Box
        component="th"
        scope="row"
        role="rowheader"
        sx={{ ...cellSx, flexBasis: "100%", pb: { xs: 1, sm: 2 } }}
      >
        <Typography component="span" sx={{ ...nameSx, display: "block" }}>
          <Link
            to={path}
            style={{
              textDecoration: "none",
              display: "inline-flex",
              alignItems: "center",
              gap: 4,
            }}
          >
            {product.name}
            <ChevronRight aria-hidden="true" size={16} />
          </Link>
        </Typography>
        {product.description !== undefined && (
          <Typography variant="body2" sx={{ color: "var(--cs-muted)" }}>
            {product.description}
          </Typography>
        )}
        {unplaced && (
          <Box sx={{ mt: 0.5 }}>
            <StatusLabel status={product.status}>
              {regionNotStated(STATUS_LABEL[product.status])}
            </StatusLabel>
          </Box>
        )}
      </Box>
      {own ? (
        <Box
          component="td"
          role="cell"
          colSpan={columns}
          sx={{ ...cellSx, flexBasis: "100%", pt: { xs: 0, sm: 2 } }}
        >
          <StatusLabel status={product.status}>{STATUS_LABEL[product.status]}</StatusLabel>
        </Box>
      ) : (
        places.map((place) => <StatusCell key={place} product={product} place={place} />)
      )}
    </Box>
  );
}

/**
 * The home page's summary: a row per product and a column per place the
 * products run in (US, EU), each cell the status statusd computed for it.
 * The detail (history, uptime, incidents) is on each product's own page.
 * Memoised: the home page re-renders on every tick of the banner's clock.
 */
export const StatusTable = memo(function StatusTable({
  products,
}: {
  products: readonly ProductSummary[];
}) {
  const places = placeNames(products);
  const captionId = useId();
  return (
    <Box
      component="table"
      role="table"
      aria-labelledby={captionId}
      sx={{ display: { xs: "block", sm: "table" }, width: "100%", borderCollapse: "collapse" }}
    >
      <caption id={captionId} className="cs-visually-hidden">
        {STATUS_TABLE_CAPTION}
      </caption>
      <Box component="thead" role="rowgroup" sx={hiddenOnPhone}>
        <tr role="row">
          <Box component="th" scope="col" role="columnheader" sx={headSx}>
            {PRODUCT_COLUMN}
          </Box>
          {(places.length > 0 ? places : [STATUS_COLUMN]).map((place) => (
            <Box
              component="th"
              scope="col"
              role="columnheader"
              key={place}
              sx={{ ...headSx, width: { sm: PLACE_COLUMN } }}
            >
              {place}
            </Box>
          ))}
        </tr>
      </Box>
      <Box
        component="tbody"
        role="rowgroup"
        sx={{ display: { xs: "block", sm: "table-row-group" } }}
      >
        {products.map((product) => (
          <ProductStatusRow key={product.id} product={product} places={places} />
        ))}
      </Box>
    </Box>
  );
});

/**
 * The table's shape while the summary loads: a row per product the page
 * knows, about as tall as the table, so little moves when the data arrives.
 * The h1 says what is happening ("Checking status").
 */
export function StatusTableSkeleton() {
  return (
    <Box aria-busy="true">
      <Box sx={{ ...headSx, display: { xs: "none", sm: "block" } }}>
        <Skeleton variant="text" width="5rem" />
      </Box>
      {FALLBACK_PRODUCTS.map((product, i) => (
        <Box
          key={product.id}
          sx={{
            ...cellSx,
            display: "flex",
            flexDirection: { xs: "column", sm: "row" },
            justifyContent: "space-between",
            gap: { xs: 1, sm: 2 },
            borderTop:
              i === 0 ? { xs: 0, sm: "1px solid var(--cs-border)" } : "1px solid var(--cs-border)",
          }}
        >
          <Box sx={{ flex: 1 }}>
            <Skeleton variant="text" width="40%" sx={nameSx} />
            <Skeleton variant="text" width="20%" />
          </Box>
          <Skeleton variant="text" width="30%" />
        </Box>
      ))}
    </Box>
  );
}
