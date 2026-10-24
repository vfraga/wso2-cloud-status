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

import { Box } from "@wso2/oxygen-ui";
import { useEffect, useMemo } from "react";
import type { Incident, Summary } from "../api/types";
import { ActiveIncidents } from "../components/ActiveIncidents";
import { Banner } from "../components/Banner";
import { FallbackLinks } from "../components/FallbackLinks";
import { HistoryLegend } from "../components/HistoryLegend";
import { PastIncidents } from "../components/PastIncidents";
import { ProductRow } from "../components/ProductRow";
import { ProductListSkeleton } from "../components/Skeletons";
import { pageTitle, useDocumentTitle } from "../hooks/useDocumentTitle";
import { PageNowProvider, usePageNow } from "../hooks/useNow";
import { useKnownUntil, type PolledState } from "../hooks/usePolled";
import { useIncidents, useSummary } from "../hooks/useResources";
import { bannerFreshness } from "../lib/dataNotes";
import { rememberProducts } from "../lib/fallbackProducts";
import { summaryHeadline, type Headline } from "../lib/headline";
import { BANNER_LABEL } from "../lib/status";
import { earliest } from "../lib/time";
import { CARD_RADIUS } from "../theme/shape";

const NO_DATA: Headline = { status: "unknown", label: BANNER_LABEL.unknown };
const NONE: readonly Incident[] = [];

export function HomePage() {
  const summary = useSummary();
  const incidents = useIncidents();
  // The site's name alone: a tab is short, and the status is the h1 and announced.
  useDocumentTitle(pageTitle());
  return (
    <PageNowProvider skewMs={summary.skewMs}>
      <HomeBody summary={summary} incidents={incidents} />
    </PageNowProvider>
  );
}

function HomeBody({
  summary,
  incidents,
}: {
  summary: PolledState<Summary>;
  incidents: PolledState<Incident[]>;
}) {
  const incidentById = useMemo(
    () => new Map((incidents.data ?? []).map((i) => [i.id, i])),
    [incidents.data],
  );
  const data = summary.data;
  const products = useMemo(() => new Map((data?.products ?? []).map((p) => [p.id, p])), [data]);
  useEffect(() => {
    if (data) rememberProducts(data.products);
  }, [data]);
  // When the page cannot vouch for its data, nothing shown runs past it. The
  // rows and Past incidents read both resources, so they stop at the earlier.
  const summaryUntil = useKnownUntil(summary);
  const bothUntil = earliest(summaryUntil, useKnownUntil(incidents));
  return (
    <>
      <HomeBanner summary={summary} known={incidents.data ?? NONE} />
      {data && (
        <ActiveIncidents
          incidents={data.activeIncidents}
          products={products}
          knownUntil={summaryUntil}
        />
      )}
      <Box
        component="section"
        aria-label="Products"
        sx={{
          mt: { xs: 3, sm: 4 },
          bgcolor: "var(--cs-surface)",
          border: "1px solid var(--cs-border)",
          borderRadius: CARD_RADIUS,
        }}
      >
        <ProductList
          data={data}
          failed={summary.failed}
          incidents={incidentById}
          knownUntil={bothUntil}
        />
      </Box>
      {data && data.products.length > 0 && <HistoryLegend />}
      <PastIncidents
        state={{
          incidents: incidents.data,
          // generated_at, the age of the snapshot the list comes from.
          checkedAt: incidents.generatedAt,
          lastSuccessAt: incidents.lastSuccessAt,
          failed: incidents.failed,
          servedStale: incidents.staleOnArrival,
          skewMs: incidents.skewMs,
          knownUntil: bothUntil,
        }}
        // Null while the summary is loading: which days the list covers is not known yet.
        products={data?.products ?? (summary.failed ? [] : null)}
      />
    </>
  );
}

function HomeBanner({
  summary,
  known,
}: {
  summary: PolledState<Summary>;
  known: readonly Incident[];
}) {
  const now = usePageNow();
  const data = summary.data;
  return (
    <Banner
      headline={data ? summaryHeadline(data) : NO_DATA}
      loading={data === null && !summary.failed}
      {...bannerFreshness(summary, data?.products ?? null, known, now)}
    />
  );
}

function ProductList({
  data,
  failed,
  incidents,
  knownUntil,
}: {
  data: Summary | null;
  failed: boolean;
  incidents: ReadonlyMap<string, Incident>;
  knownUntil: Date | null;
}) {
  // A summary without products (a 200 from something other than the service,
  // for example) is no better than none: the links are what is left.
  if (data && data.products.length > 0) {
    return (
      <Box
        component="ul"
        sx={{ m: 0, p: 0, "& > li + li": { borderTop: "1px solid var(--cs-border)" } }}
      >
        {data.products.map((product) => (
          <ProductRow
            key={product.id}
            product={product}
            incidents={incidents}
            knownUntil={knownUntil}
          />
        ))}
      </Box>
    );
  }
  return failed || data ? <FallbackLinks /> : <ProductListSkeleton />;
}
