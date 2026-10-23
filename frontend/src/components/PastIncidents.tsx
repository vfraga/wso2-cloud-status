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
import { Clock } from "@wso2/oxygen-ui-icons-react";
import type { Incident, ProductSummary } from "../api/types";
import { config } from "../config";
import { usePageNow } from "../hooks/useNow";
import { lastKnownAt, missingIncidents, notCoveredBefore } from "../lib/dataNotes";
import { freshness, type FreshnessInputs } from "../lib/freshness";
import { groupByDay } from "../lib/incidents";
import {
  PAST_INCIDENTS_FAILED,
  PAST_INCIDENTS_LOADING,
  PAST_INCIDENTS_UNAVAILABLE,
  pastIncidentsStale,
  quietDayText,
} from "../lib/status";
import { formatMinutes } from "../lib/time";
import { DataNote } from "./DataNote";
import { ExternalAnchor } from "./ExternalAnchor";
import { IncidentItem } from "./IncidentMeta";
import { IncidentsUnavailable } from "./IncidentsUnavailable";

/** The incident list's own polling state, so a later failure or an old copy is not hidden. */
interface IncidentListState extends FreshnessInputs {
  incidents: readonly Incident[] | null;
  /** When the list's data stopped (useKnownUntil); absent or null while it is current. */
  knownUntil?: Date | null;
}

interface PastIncidentsProps {
  state: IncidentListState;
  /** Null while the summary is loading; empty when it failed or listed none. */
  products: readonly ProductSummary[] | null;
}

/**
 * After the first load, a note when the list could not be refreshed or is
 * past the limit: "just now" for a failure that is new, the limit once it is
 * not, so the note never says "just now" an hour later.
 */
function RefreshNote({ state, now }: { state: FreshnessInputs; now: Date }) {
  // `now` is the page's server-corrected clock; freshness wants this browser's.
  const fresh = freshness(new Date(now.getTime() + (state.skewMs ?? 0)), state);
  if (!fresh.outdated) return null;
  return (
    <Box sx={{ mt: 1.5 }}>
      <DataNote icon={<Clock aria-hidden="true" size={14} />}>
        {state.failed && !fresh.unavailable
          ? PAST_INCIDENTS_FAILED
          : pastIncidentsStale(formatMinutes(config.staleAfterMs))}
      </DataNote>
    </Box>
  );
}

/**
 * The last days of incidents, by the reader's local day. A product whose
 * incident data is unavailable or incomplete is named with a link to its own
 * page, and a quiet day the data does not fully cover speaks only for the
 * other products: it never says "No incidents reported." for it. Without the
 * summary nothing says what the list covers, so no quiet day is vouched for.
 */
export function PastIncidents({ state, products: known }: PastIncidentsProps) {
  const now = usePageNow();
  const incidents = known === null ? null : state.incidents;
  const products = known ?? [];
  const byId = new Map(products.map((p) => [p.id, p]));
  const missing = missingIncidents(products, incidents ?? []);
  const knownUntil = state.knownUntil ?? null;
  // A day that ends after the list's data stopped is covered for no product.
  const notCovered = (end: Date) =>
    knownUntil !== null && end.getTime() > knownUntil.getTime()
      ? products
      : notCoveredBefore(missing, end);
  return (
    <Box component="section" aria-labelledby="past-incidents" sx={{ mt: { xs: 6, sm: 7 } }}>
      <Typography id="past-incidents" component="h2" sx={{ fontSize: "1.375rem", fontWeight: 600 }}>
        Past incidents
      </Typography>
      {products.length > 0 && (
        <Stack
          component="nav"
          aria-label="Full incident history"
          direction="row"
          useFlexGap
          sx={{ flexWrap: "wrap", columnGap: 2, rowGap: 0.5, mt: 1, alignItems: "center" }}
        >
          <Typography variant="body2" sx={{ color: "var(--cs-muted)" }}>
            Full history:
          </Typography>
          {products.map((p) => (
            <ExternalAnchor key={p.id} href={p.pageUrl} label={`Full history for ${p.name}`}>
              {p.name}
            </ExternalAnchor>
          ))}
        </Stack>
      )}
      {incidents === null ? (
        <Typography sx={{ mt: 2, color: "var(--cs-muted)" }}>
          {state.incidents === null && state.failed
            ? PAST_INCIDENTS_UNAVAILABLE
            : PAST_INCIDENTS_LOADING}
        </Typography>
      ) : (
        <>
          <RefreshNote state={state} now={now} />
          <IncidentsUnavailable missing={missing} />
          {groupByDay(incidents, now, config.historyDays).map((group) => (
            <Box
              key={group.key}
              component="section"
              aria-labelledby={`day-${group.key}`}
              sx={{ mt: 3 }}
            >
              <Typography
                id={`day-${group.key}`}
                component="h3"
                sx={{
                  fontSize: "1rem",
                  fontWeight: 600,
                  pb: 0.75,
                  borderBottom: "1px solid var(--cs-border)",
                }}
              >
                {group.label}
              </Typography>
              {group.incidents.length === 0 ? (
                <Typography variant="body2" sx={{ color: "var(--cs-muted)", pt: 1.25 }}>
                  {quietDayText(notCovered(group.end).length, products.length)}
                </Typography>
              ) : (
                <Box component="ul" sx={{ m: 0, p: 0 }}>
                  {group.incidents.map((incident) => {
                    const product = byId.get(incident.productId);
                    return (
                      <IncidentItem
                        key={incident.id}
                        incident={incident}
                        productName={product?.name ?? incident.productId}
                        now={now}
                        // Started on an earlier day: the start says which.
                        withDate={incident.startedAt.getTime() < group.start.getTime()}
                        lastKnownAt={lastKnownAt(incident, product, knownUntil)}
                      />
                    );
                  })}
                </Box>
              )}
            </Box>
          ))}
        </>
      )}
    </Box>
  );
}
