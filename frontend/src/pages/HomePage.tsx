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
import { useEffect, useMemo } from "react";
import type { Summary } from "../api/types";
import { ActiveIncidents } from "../components/ActiveIncidents";
import { Banner } from "../components/Banner";
import { StatusTable, StatusTableSkeleton } from "../components/StatusTable";
import { pageTitle, useDocumentTitle } from "../hooks/useDocumentTitle";
import { PageNowProvider, usePageNow } from "../hooks/useNow";
import { useKnownUntil, type PolledState } from "../hooks/usePolled";
import { useSummary } from "../hooks/useResources";
import { bannerFreshness } from "../lib/dataNotes";
import { rememberProducts } from "../lib/fallbackProducts";
import { summaryHeadline, type Headline } from "../lib/headline";
import { Link } from "../lib/router";
import { BANNER_LABEL, INCIDENT_HISTORY, PRODUCT_STATUS_UNAVAILABLE } from "../lib/status";
import { CARD_RADIUS } from "../theme/shape";

const NO_DATA: Headline = { status: "unknown", label: BANNER_LABEL.unknown };
const cardSx = {
  mt: { xs: 3, sm: 4 },
  bgcolor: "var(--cs-surface)",
  border: "1px solid var(--cs-border)",
  borderRadius: CARD_RADIUS,
  overflow: "hidden",
} as const;

/**
 * The current status at a glance: the headline, the incidents going on now,
 * and a table of each product's status per region, then one link to the
 * incident history. History, uptime and past incidents are on each
 * product's page.
 */
export function HomePage() {
  const summary = useSummary();
  // The site's name alone: a tab is short, and the status is the h1 and announced.
  useDocumentTitle(pageTitle());
  return (
    <PageNowProvider skewMs={summary.skewMs}>
      <HomeBody summary={summary} />
    </PageNowProvider>
  );
}

function HomeBody({ summary }: { summary: PolledState<Summary> }) {
  const data = summary.data;
  const products = useMemo(() => new Map((data?.products ?? []).map((p) => [p.id, p])), [data]);
  useEffect(() => {
    if (data) rememberProducts(data.products);
  }, [data]);
  // When the page cannot vouch for its data, an ongoing incident's duration stops there.
  const knownUntil = useKnownUntil(summary);
  const banner = <HomeBanner summary={summary} />;
  if (data === null && !summary.failed) {
    return (
      <>
        {banner}
        <Box sx={cardSx}>
          <StatusTableSkeleton />
        </Box>
      </>
    );
  }
  return (
    <>
      {banner}
      {data && (
        <ActiveIncidents
          incidents={data.activeIncidents}
          products={products}
          knownUntil={knownUntil}
        />
      )}
      <Box component="section" aria-label="Products" sx={cardSx}>
        {/* Without products: a failed summary, or a 200 from something other than the service. */}
        {data && data.products.length > 0 ? (
          <StatusTable products={data.products} />
        ) : (
          <Typography sx={{ p: 2.5 }}>{PRODUCT_STATUS_UNAVAILABLE}</Typography>
        )}
      </Box>
      <Typography variant="body2" sx={{ mt: 2 }}>
        <Link to="/history">{INCIDENT_HISTORY}</Link>
      </Typography>
    </>
  );
}

function HomeBanner({ summary }: { summary: PolledState<Summary> }) {
  const now = usePageNow();
  const data = summary.data;
  return (
    <Banner
      headline={data ? summaryHeadline(data) : NO_DATA}
      loading={data === null && !summary.failed}
      // The incidents the page shows are the active ones.
      {...bannerFreshness(summary, data?.products ?? null, data?.activeIncidents ?? [], now)}
    />
  );
}
