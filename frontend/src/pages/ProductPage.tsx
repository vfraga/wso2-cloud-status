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
import { ArrowLeft } from "@wso2/oxygen-ui-icons-react";
import { useMemo } from "react";
import type { Incident, ProductDetail } from "../api/types";
import { ActiveIncidents } from "../components/ActiveIncidents";
import { Banner } from "../components/Banner";
import { ExternalAnchor } from "../components/ExternalAnchor";
import { HistoryLegend } from "../components/HistoryLegend";
import { HistoryStrip } from "../components/HistoryStrip";
import { IncidentItem } from "../components/IncidentMeta";
import { IncidentsUnavailable } from "../components/IncidentsUnavailable";
import { ProductNotes } from "../components/ProductNotes";
import { LocationPanel, RegionDetailPanel } from "../components/RegionDetailPanel";
import { GridRow, ProductUptime, UptimeHeader, uptimeWindows } from "../components/Uptime";
import { ProductListSkeleton } from "../components/Skeletons";
import { pageTitle, useDocumentTitle } from "../hooks/useDocumentTitle";
import { PageNowProvider, usePageNow } from "../hooks/useNow";
import { useKnownUntil, type PolledState } from "../hooks/usePolled";
import { useProduct } from "../hooks/useResources";
import { knownProduct, type FallbackProduct } from "../lib/fallbackProducts";
import {
  bannerFreshness,
  completeUntil,
  missingIncidents,
  type PartlyShown,
} from "../lib/dataNotes";
import { productHeadline, type Headline } from "../lib/headline";
import { byStartDay, isOngoing } from "../lib/incidents";
import { regionRows } from "../lib/regions";
import { Link } from "../lib/router";
import {
  BANNER_LABEL,
  NO_INCIDENTS,
  NO_OTHER_INCIDENTS,
  PRODUCT_STATUS_UNAVAILABLE,
  UPTIME_NOTE,
  olderIncidents,
  recentSpan,
} from "../lib/status";
import { earliest } from "../lib/time";
import { CARD_RADIUS } from "../theme/shape";
import { NotFoundPage } from "./NotFoundPage";

const sectionHeading = { fontSize: "1.25rem", fontWeight: 600 } as const;
const sectionNote = { color: "var(--cs-muted)", mt: 0.5 } as const;
const NO_DATA: Headline = { status: "unknown", label: BANNER_LABEL.unknown };

/** For a stale feed that never answered: whether another source's data of that kind is shown. */
function partlyShown(product: ProductDetail): PartlyShown {
  const uptime = product.regionDetails.some(
    (r) =>
      r.uptime.length > 0 || r.groups.some((g) => g.components.some((c) => c.uptime.length > 0)),
  );
  return { incidents: product.incidents.length > 0, uptime };
}

/**
 * The resolved incidents of the history's days (the API lists no older
 * ones), under the reader's local day they started; the ongoing ones are
 * listed at the top of the page.
 */
function RecentIncidents({ product, now }: { product: ProductDetail; now: Date }) {
  const missing = missingIncidents([product], product.incidents);
  const resolved = product.incidents.filter((i) => !isOngoing(i));
  const ongoing = resolved.length < product.incidents.length;
  return (
    <Box component="section" aria-labelledby="product-incidents" sx={{ mt: 4 }}>
      <Typography id="product-incidents" component="h2" sx={sectionHeading}>
        Recent incidents
      </Typography>
      <Typography variant="body2" sx={sectionNote}>
        {recentSpan(product.history.length)}{" "}
        <ExternalAnchor href={product.pageUrl} label={olderIncidents(product.name)} inline>
          {olderIncidents(product.name)}
        </ExternalAnchor>
      </Typography>
      <IncidentsUnavailable missing={missing} />
      {/* "No incidents reported." only when the incident data is complete. */}
      {resolved.length === 0 && missing.length === 0 && (
        <Typography variant="body2" sx={{ color: "var(--cs-muted)", mt: 2 }}>
          {ongoing ? NO_OTHER_INCIDENTS : NO_INCIDENTS}
        </Typography>
      )}
      {byStartDay(resolved).map((day) => (
        <Box key={day.key} sx={{ mt: 2.5 }}>
          <Typography
            component="h3"
            sx={{
              fontSize: "0.875rem",
              fontWeight: 600,
              color: "var(--cs-muted)",
              pb: 0.75,
              borderBottom: "1px solid var(--cs-border)",
            }}
          >
            {day.label}
          </Typography>
          <Stack component="ul" sx={{ m: 0, p: 0 }}>
            {day.incidents.map((incident) => (
              <IncidentItem key={incident.id} incident={incident} now={now} titleAs="h4" />
            ))}
          </Stack>
        </Box>
      ))}
    </Box>
  );
}

function ProductBody({
  product,
  knownUntil,
}: {
  product: ProductDetail;
  /** When the page's own data stopped (useKnownUntil); null while it is current. */
  knownUntil: Date | null;
}) {
  const now = usePageNow();
  const incidentById = useMemo(
    () => new Map<string, Incident>(product.incidents.map((i) => [i.id, i])),
    [product],
  );
  const self = useMemo(() => new Map([[product.id, product]]), [product]);
  const windows = useMemo(() => uptimeWindows(product.regionDetails), [product]);
  const partly = partlyShown(product);
  return (
    <>
      {/* The banner's h1 names the product; the link out stays below the status. */}
      <Box sx={{ mt: 2 }}>
        <ProductNotes product={product} partly={partly} />
        <Box sx={{ mt: 1.5 }}>
          <ExternalAnchor
            href={product.pageUrl}
            label={`Open the ${product.name} status page`}
            weight={600}
          >
            Open the {product.name} status page
          </ExternalAnchor>
        </Box>
      </Box>
      {/* Ongoing incidents first, as on the home page, above history and regions. */}
      <ActiveIncidents
        incidents={product.incidents.filter(isOngoing)}
        products={self}
        linked={false}
        knownUntil={knownUntil}
      />
      <Box
        component="section"
        aria-label="History"
        sx={{
          mt: 3,
          p: 2.5,
          bgcolor: "var(--cs-surface)",
          border: "1px solid var(--cs-border)",
          borderRadius: CARD_RADIUS,
        }}
      >
        <HistoryStrip
          productName={product.name}
          days={product.history}
          incidents={incidentById}
          completeUntil={earliest(completeUntil(product), knownUntil)}
        />
        <HistoryLegend />
      </Box>
      <Box component="section" aria-labelledby="regions" sx={{ mt: 4 }}>
        <Typography id="regions" component="h2" sx={sectionHeading}>
          Regions
        </Typography>
        {partly.uptime && (
          <Typography variant="body2" sx={sectionNote}>
            {UPTIME_NOTE}
          </Typography>
        )}
        <ProductUptime.Provider value={windows}>
          {/* Each location's row carries the window codes; regions without one get them here. */}
          {product.locations.length === 0 && (
            <Box sx={{ mt: 1.5 }}>
              <GridRow name={null} status={null} figures={<UptimeHeader />} />
            </Box>
          )}
          <Box component="ul" sx={{ m: 0, mt: 1, p: 0 }}>
            {regionRows(product.locations, product.regionDetails).map((row) =>
              row.kind === "location" ? (
                <LocationPanel
                  key={`location-${row.location.id}`}
                  location={row.location}
                  regions={row.regions}
                />
              ) : (
                <RegionDetailPanel key={row.region.id} region={row.region} />
              ),
            )}
          </Box>
        </ProductUptime.Provider>
      </Box>
      <RecentIncidents product={product} now={now} />
    </>
  );
}

/** The product's body, stopped at its data's known-until time when the page cannot vouch for it. */
function KnownProductBody({
  state,
  product,
}: {
  state: PolledState<ProductDetail | null>;
  product: ProductDetail;
}) {
  return <ProductBody product={product} knownUntil={useKnownUntil(state)} />;
}

/**
 * Without data: a skeleton while loading, or, when the API failed or sent
 * something unreadable, a link to the product's own page.
 */
function Pending({ failed, known }: { failed: boolean; known: FallbackProduct | undefined }) {
  if (!failed) return <ProductListSkeleton />;
  return (
    <Typography sx={{ mt: 3 }}>
      {PRODUCT_STATUS_UNAVAILABLE}{" "}
      {known && (
        <ExternalAnchor href={known.pageUrl} label={`Open the ${known.name} status page`} inline>
          Open the {known.name} status page
        </ExternalAnchor>
      )}
    </Typography>
  );
}

function ProductBanner({
  state,
  name,
}: {
  state: PolledState<ProductDetail | null>;
  name: string | undefined;
}) {
  const product = state.data;
  const now = usePageNow();
  return (
    <Banner
      headline={product ? productHeadline(product) : NO_DATA}
      loading={product === null && !state.failed && state.lastSuccessAt === null}
      {...bannerFreshness(state, product ? [product] : null, product?.incidents ?? [], now)}
      {...(name === undefined ? {} : { subject: name })}
      {...(product?.description === undefined ? {} : { alias: product.description })}
    />
  );
}

export function ProductPage({ id }: { id: string }) {
  const state = useProduct(id);
  const product = state.data;
  const known = product ?? knownProduct(id);
  // A 404 for a product the catalogue knows is the API's failure (a misrouted
  // ingress answers 404 for every path), not a missing product.
  const notFound = state.notFound && known === undefined;
  const name = known?.name;
  useDocumentTitle(pageTitle(notFound ? "Not found" : name));

  if (notFound) return <NotFoundPage what="product" />;

  return (
    <>
      <Typography variant="body2" sx={{ mb: 2 }}>
        <Link to="/" style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
          <ArrowLeft aria-hidden="true" size={14} />
          All products
        </Link>
      </Typography>
      <PageNowProvider skewMs={state.skewMs}>
        <ProductBanner state={state} name={name} />
        {product ? (
          <KnownProductBody state={state} product={product} />
        ) : (
          <Pending failed={state.failed || state.lastSuccessAt !== null} known={known} />
        )}
      </PageNowProvider>
    </>
  );
}
