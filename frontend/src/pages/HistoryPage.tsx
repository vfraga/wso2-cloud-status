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

import { Box, FormControl, InputLabel, NativeSelect, Stack, Typography } from "@wso2/oxygen-ui";
import { ArrowLeft } from "@wso2/oxygen-ui-icons-react";
import type { Incident, IncidentList, IncidentListProduct } from "../api/types";
import { IncidentItem } from "../components/IncidentMeta";
import { IncidentsUnavailable } from "../components/IncidentsUnavailable";
import { ProductListSkeleton } from "../components/Skeletons";
import { pageTitle, useDocumentTitle } from "../hooks/useDocumentTitle";
import { PageNowProvider, usePageNow } from "../hooks/useNow";
import { useKnownUntil, type PolledState } from "../hooks/usePolled";
import { useIncidentList } from "../hooks/useResources";
import { useViewHeading } from "../hooks/useViewFocus";
import { completeUntil, lastKnownAt, missingIncidents } from "../lib/dataNotes";
import { FALLBACK_PRODUCTS } from "../lib/fallbackProducts";
import { byStartMonth } from "../lib/incidents";
import { Link, replaceLocation, useSearchParam } from "../lib/router";
import {
  ALL_PRODUCTS_OPTION,
  HISTORY_UNAVAILABLE,
  INCIDENT_HISTORY,
  NO_INCIDENTS,
  PRODUCT_FILTER_LABEL,
  historySpan,
} from "../lib/status";
import {
  earliest,
  formatMonthHeading,
  formatUtcDate,
  localMonthKey,
  localMonthStart,
  nextLocalMonth,
} from "../lib/time";

const monthHeading = {
  fontSize: "0.875rem",
  fontWeight: 600,
  color: "var(--cs-muted)",
  pb: 0.75,
  borderBottom: "1px solid var(--cs-border)",
} as const;

/** The most months the page lists as covered: ten years. */
const MAX_MONTHS = 120;

/** One month of the history: its incidents, or none when the data covers all of it. */
export interface HistoryMonth {
  key: string;
  start: Date;
  incidents: Incident[];
}

/**
 * The months to show, newest first: every month the selected products'
 * incidents fully cover up to now (`coveredFrom` to `until`, where null
 * `until` means current), and any month that holds an incident. A month the
 * data covers only in part is shown only for its incidents, so the page never
 * calls a month quiet that it cannot vouch for.
 */
export function historyMonths(
  incidents: readonly Incident[],
  coveredFrom: Date | null,
  until: Date | null,
  now: Date,
): HistoryMonth[] {
  const byMonth = byStartMonth(incidents);
  const starts = new Map<string, Date>();
  for (const list of byMonth.values()) {
    const first = list[0];
    if (first) starts.set(localMonthKey(first.startedAt), localMonthStart(first.startedAt));
  }
  const end = (until ?? now).getTime();
  // Bounded, so a coverage start the page misreads cannot run on for ever.
  for (
    let m = localMonthStart(now), n = 0;
    coveredFrom !== null && m.getTime() >= coveredFrom.getTime() && n < MAX_MONTHS;
    m = localMonthStart(new Date(m.getTime() - 1)), n++
  ) {
    if (Math.min(nextLocalMonth(m).getTime(), now.getTime()) <= end)
      starts.set(localMonthKey(m), m);
  }
  return [...starts.entries()]
    .sort(([, a], [, b]) => b.getTime() - a.getTime())
    .map(([key, start]) => ({ key, start, incidents: byMonth.get(key) ?? [] }));
}

/** The latest coverage start among the products, null when any of them has none. */
function coverageStart(products: readonly IncidentListProduct[]): Date | null {
  let latest: Date | null = null;
  for (const p of products) {
    if (p.coveredFrom === null) return null;
    if (latest === null || p.coveredFrom.getTime() > latest.getTime()) latest = p.coveredFrom;
  }
  return latest;
}

function ProductFilter({
  products,
  selected,
}: {
  products: readonly { id: string; name: string }[];
  selected: string;
}) {
  return (
    <FormControl sx={{ mt: 2, minWidth: 220 }}>
      <InputLabel variant="standard" htmlFor="history-product" shrink>
        {PRODUCT_FILTER_LABEL}
      </InputLabel>
      <NativeSelect
        value={selected}
        inputProps={{ id: "history-product", name: "product" }}
        onChange={(event) => {
          const id = event.target.value;
          replaceLocation(id === "" ? "/history" : `/history?product=${encodeURIComponent(id)}`);
        }}
      >
        <option value="">{ALL_PRODUCTS_OPTION}</option>
        {products.map((p) => (
          <option key={p.id} value={p.id}>
            {p.name}
          </option>
        ))}
      </NativeSelect>
    </FormControl>
  );
}

function HistoryList({
  list,
  selected,
  knownUntil,
}: {
  list: IncidentList;
  selected: string;
  knownUntil: Date | null;
}) {
  const now = usePageNow();
  const products = selected === "" ? list.products : list.products.filter((p) => p.id === selected);
  const ids = new Set(products.map((p) => p.id));
  const incidents = list.incidents.filter((i) => ids.has(i.productId));
  const byId = new Map(products.map((p) => [p.id, p]));
  const coveredFrom = coverageStart(products);
  const until = earliest(...products.map(completeUntil), knownUntil);
  return (
    <>
      <Typography variant="body2" sx={{ color: "var(--cs-muted)", mt: 1.5 }}>
        {historySpan(coveredFrom === null ? null : formatUtcDate(coveredFrom))}
      </Typography>
      <IncidentsUnavailable missing={missingIncidents(products, incidents)} />
      {historyMonths(incidents, coveredFrom, until, now).map((month) => (
        <Box
          key={month.key}
          component="section"
          aria-labelledby={`month-${month.key}`}
          sx={{ mt: 3 }}
        >
          <Typography id={`month-${month.key}`} component="h2" sx={monthHeading}>
            {formatMonthHeading(month.start)}
          </Typography>
          {month.incidents.length === 0 ? (
            <Typography variant="body2" sx={{ color: "var(--cs-muted)", mt: 1.5 }}>
              {NO_INCIDENTS}
            </Typography>
          ) : (
            <Stack component="ul" sx={{ m: 0, p: 0 }}>
              {month.incidents.map((incident) => {
                const product = byId.get(incident.productId);
                return (
                  <IncidentItem
                    key={incident.id}
                    incident={incident}
                    now={now}
                    withDate
                    titleAs="h3"
                    lastKnownAt={lastKnownAt(incident, product, knownUntil)}
                    {...(selected === ""
                      ? {
                          productName: product?.name ?? incident.productId,
                          productPath: `/products/${incident.productId}`,
                        }
                      : {})}
                  />
                );
              })}
            </Stack>
          )}
        </Box>
      ))}
    </>
  );
}

/** The list, or a line when it could not be loaded, or a skeleton while it loads. */
function HistoryContent({
  state,
  selected,
  knownUntil,
}: {
  state: PolledState<IncidentList>;
  selected: string;
  knownUntil: Date | null;
}) {
  if (state.data !== null) {
    return <HistoryList list={state.data} selected={selected} knownUntil={knownUntil} />;
  }
  if (state.failed) return <Typography sx={{ mt: 3 }}>{HISTORY_UNAVAILABLE}</Typography>;
  return <ProductListSkeleton />;
}

function HistoryBody({
  state,
  product,
}: {
  state: PolledState<IncidentList>;
  product: string | null;
}) {
  const list = state.data;
  const knownUntil = useKnownUntil(state);
  const heading = useViewHeading<HTMLHeadingElement>(list !== null || state.failed);
  const options = list?.products ?? FALLBACK_PRODUCTS;
  // An id the list does not hold reads as every product.
  const selected = options.some((p) => p.id === product) ? (product ?? "") : "";
  return (
    <>
      <Typography
        component="h1"
        ref={heading}
        tabIndex={-1}
        sx={{ fontSize: { xs: "1.375rem", sm: "1.75rem" }, lineHeight: 1.2, fontWeight: 600 }}
      >
        {INCIDENT_HISTORY}
      </Typography>
      <ProductFilter products={options} selected={selected} />
      <HistoryContent state={state} selected={selected} knownUntil={knownUntil} />
    </>
  );
}

/** Every incident the API holds, by month, for all products or one. */
export function HistoryPage() {
  const state = useIncidentList();
  const product = useSearchParam("product");
  useDocumentTitle(pageTitle(INCIDENT_HISTORY));
  return (
    <>
      <Typography variant="body2" sx={{ mb: 2 }}>
        <Link to="/" style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
          <ArrowLeft aria-hidden="true" size={14} />
          All products
        </Link>
      </Typography>
      <PageNowProvider skewMs={state.skewMs}>
        <HistoryBody state={state} product={product} />
      </PageNowProvider>
    </>
  );
}
