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
import type { Incident } from "../api/types";
import { incidentDuration, isOngoing, stateLabel } from "../lib/incidents";
import { Link } from "../lib/router";
import { IMPACT_LABEL, lasted, ongoingAsOf, ongoingFor } from "../lib/status";
import {
  formatClock,
  formatDateClock,
  formatDuration,
  formatUtcDateTime,
  formatUtcTime,
} from "../lib/time";
import { ExternalAnchor } from "./ExternalAnchor";
import { StatusLabel } from "./StatusIcon";

function When({ date, withDate }: { date: Date; withDate: boolean }) {
  return (
    <time dateTime={date.toISOString()} title={formatUtcDateTime(date)}>
      {withDate ? formatDateClock(date) : formatClock(date)}
    </time>
  );
}

interface IncidentItemProps {
  incident: Incident;
  /** Names the product; left out on the product's own page. */
  productName?: string;
  now: Date;
  /** Show the start date as well as the time (active incidents; days are headed elsewhere). */
  withDate?: boolean;
  /** Heading level of the title; one below the section heading. */
  titleAs?: "h3" | "h4";
  /** Links the product name to its page here and adds a link to the updates on its own status page. */
  links?: { productPath: string; pageUrl: string };
  /**
   * For an open incident whose feed stopped, its last successful fetch: the
   * duration stops there and the line says it is the last known state.
   */
  lastKnownAt?: Date | null;
}

function durationText(incident: Incident, now: Date, lastKnownAt: Date | null): string {
  if (incident.resolvedAt !== null) {
    return lasted(formatDuration(incidentDuration(incident, now)));
  }
  if (lastKnownAt === null) return ongoingFor(formatDuration(incidentDuration(incident, now)));
  return ongoingAsOf(
    formatDuration(incidentDuration(incident, lastKnownAt)),
    formatUtcTime(lastKnownAt, now),
  );
}

export function IncidentItem({
  incident,
  productName,
  now,
  withDate = false,
  titleAs = "h4",
  links,
  lastKnownAt = null,
}: IncidentItemProps) {
  const ongoing = isOngoing(incident);
  const state = stateLabel(incident.state);
  return (
    <Box component="li" sx={{ py: 1.5, listStyle: "none" }}>
      <Typography component={titleAs} sx={{ fontWeight: 600, fontSize: "1rem", lineHeight: 1.35 }}>
        {incident.title}
      </Typography>
      <Stack
        direction="row"
        useFlexGap
        sx={{ flexWrap: "wrap", columnGap: 2, rowGap: 0.5, mt: 0.75, alignItems: "center" }}
      >
        {productName !== undefined && (
          <Typography variant="body2" sx={{ color: "var(--cs-muted)" }}>
            {links ? <Link to={links.productPath}>{productName}</Link> : productName}
          </Typography>
        )}
        <StatusLabel status={incident.impact}>{IMPACT_LABEL[incident.impact]}</StatusLabel>
        {ongoing && state !== "" && (
          <Typography variant="body2" sx={{ fontWeight: 600 }}>
            {state}
          </Typography>
        )}
      </Stack>
      <Times incident={incident} now={now} withDate={withDate} lastKnownAt={lastKnownAt} />
      {links && productName !== undefined && (
        <UpdatesLink productName={productName} pageUrl={links.pageUrl} />
      )}
    </Box>
  );
}

/** "Started 8:02 PM, ended 9:56 PM. Lasted 1h 54m." */
function Times({
  incident,
  now,
  withDate,
  lastKnownAt,
}: {
  incident: Incident;
  now: Date;
  withDate: boolean;
  lastKnownAt: Date | null;
}) {
  return (
    <Typography variant="body2" sx={{ color: "var(--cs-muted)", mt: 0.5 }}>
      Started <When date={incident.startedAt} withDate={withDate} />
      {incident.resolvedAt && (
        <>
          , ended{" "}
          <When
            date={incident.resolvedAt}
            withDate={!sameDay(incident.startedAt, incident.resolvedAt)}
          />
        </>
      )}
      {`. ${durationText(incident, now, lastKnownAt)}`}
    </Typography>
  );
}

function UpdatesLink({ productName, pageUrl }: { productName: string; pageUrl: string }) {
  if (pageUrl === "") return null;
  const text = `Updates on the ${productName} status page`;
  return (
    <Box sx={{ mt: 0.5 }}>
      <ExternalAnchor href={pageUrl} label={text} weight={500}>
        {text}
      </ExternalAnchor>
    </Box>
  );
}

function sameDay(a: Date, b: Date): boolean {
  return a.toDateString() === b.toDateString();
}
