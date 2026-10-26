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
import { Info } from "@wso2/oxygen-ui-icons-react";
import { useState } from "react";
import type { Status } from "../api/types";
import { config } from "../config";
import { useBannerNow } from "../hooks/useNow";
import { useViewHeading } from "../hooks/useViewFocus";
import { freshness, type Freshness, type FreshnessInputs } from "../lib/freshness";
import type { DetailLine, Headline } from "../lib/headline";
import {
  BANNER_LABEL,
  CHECKING_LABEL,
  OUT_OF_DATE,
  REFRESH_FAILED_DETAIL,
  SERVICE_UNREACHABLE,
  cannotRefreshDetail,
  lastCheckOver,
  othersChecked,
  servedStaleDetail,
  statusChanged,
  statusChecked,
} from "../lib/status";
import { formatCheckAge, formatMinutes } from "../lib/time";
import { CARD_RADIUS } from "../theme/shape";
import { statusVar } from "../theme/tokens";
import { StatusIcon } from "./StatusIcon";

interface BannerProps extends FreshnessInputs {
  /** What the data says; replaced by "Status unavailable" when the data cannot be trusted. */
  headline: Headline;
  loading: boolean;
  /** Sentences about specific late data, announced with the notice (see componentNotes). */
  notes?: readonly string[];
  /** Some products are late and named in the notes: the age line speaks for the others. */
  someLate?: boolean;
  /** One secondary line under the headline, kept while the headline is shown. */
  secondary?: string;
  /** Read before the headline by screen readers, for example the product name. */
  subject?: string;
  /** The name readers also know the subject by, after it in a lighter weight: "(Choreo)". */
  alias?: string;
}

const staleAfter = formatMinutes(config.staleAfterMs);

interface NoticeInputs {
  fresh: Freshness;
  failed: boolean;
  servedStale: boolean;
}

function noticeDetail({ fresh, failed, servedStale }: NoticeInputs): string {
  if (servedStale) return servedStaleDetail(staleAfter);
  if (fresh.unavailable) return cannotRefreshDetail(staleAfter);
  if (failed) return REFRESH_FAILED_DETAIL;
  return lastCheckOver(staleAfter);
}

function noticeText(
  inputs: NoticeInputs,
  everLoaded: boolean,
  notes: readonly string[],
): string | null {
  // Nothing has been shown yet, so nothing can be out of date.
  if (!everLoaded && inputs.failed) return SERVICE_UNREACHABLE;
  const parts = [
    ...(inputs.fresh.outdated ? [`${OUT_OF_DATE} ${noticeDetail(inputs)}`] : []),
    ...notes,
  ];
  return parts.length > 0 ? parts.join(" ") : null;
}

/**
 * Two live regions that stay mounted: the notice, announced when it appears
 * or changes, and `announcement`, which only assistive technology reads. Kept
 * apart, a later notice does not repeat a status change already announced.
 */
function Notice({ text, announcement }: { text: string | null; announcement: string }) {
  return (
    <>
      <span aria-live="polite" className="cs-visually-hidden">
        {announcement}
      </span>
      <div role="status">
        {text !== null && (
          <Stack
            direction="row"
            spacing={1}
            sx={{
              mt: 1.5,
              alignItems: "flex-start",
              color: "var(--cs-text)",
              bgcolor: "var(--cs-surface)",
              border: "1px solid var(--cs-border)",
              borderRadius: CARD_RADIUS,
              px: 1.5,
              py: 1,
            }}
          >
            <Info aria-hidden="true" size={18} style={{ marginTop: 2, flexShrink: 0 }} />
            <Typography variant="body2">{text}</Typography>
          </Stack>
        )}
      </div>
    </>
  );
}

/**
 * "Status changed: Service outage." when the headline changes after it first
 * settled, so a reader who keeps the page open hears it; empty before.
 */
function useChangeAnnouncement(label: string, settled: boolean): string {
  const [seen, setSeen] = useState<{ label: string | null; text: string }>({
    label: null,
    text: "",
  });
  if (settled && seen.label !== label) {
    const text = seen.label === null ? "" : statusChanged(label);
    setSeen({ label, text });
    return text;
  }
  return seen.text;
}

/** The h1: the status, after the product's name (and the name it is also known by) on a product page. */
function HeadingText({
  subject,
  alias,
  label,
}: {
  subject: string | undefined;
  alias: string | undefined;
  label: string;
}) {
  if (subject === undefined) return <>{label}</>;
  return (
    <>
      {subject}
      {alias !== undefined && (
        <>
          {" "}
          <span style={{ fontWeight: 400 }}>({alias})</span>
        </>
      )}
      {`: ${label}`}
    </>
  );
}

/** "Status checked 3 min ago", or "Other products ..." when some are late and named in the notice. */
function AgeLine({ fresh, someLate }: { fresh: Freshness; someLate: boolean }) {
  if (fresh.ageMs === null) return null;
  const text = someLate ? othersChecked : statusChecked;
  return (
    <Typography variant="body2" sx={{ color: "var(--cs-muted)", mt: 0.5 }}>
      {text(formatCheckAge(fresh.ageMs, fresh.outdated))}
    </Typography>
  );
}

function shownHeadline(headline: Headline, loading: boolean, fresh: Freshness): Headline {
  if (loading) return { status: "unknown", label: CHECKING_LABEL };
  if (fresh.unavailable) return { status: "unknown", label: BANNER_LABEL.unknown };
  return headline;
}

/**
 * Reads the page's clock at a finer tick than the rest of the page. When this page
 * has not refreshed for longer than the limit, or the data it received was
 * already too old, the banner stops claiming a status and reads "Status
 * unavailable"; the products keep their last state. The h1 takes focus after
 * an in-page navigation once it shows the status or the failure, not while
 * it reads "Checking status" (Layout), so it has tabIndex -1.
 */
export function Banner({
  headline,
  loading,
  notes = [],
  someLate = false,
  secondary,
  subject,
  alias,
  ...inputs
}: BannerProps) {
  const now = useBannerNow();
  const heading = useViewHeading<HTMLHeadingElement>(!loading);
  const fresh = freshness(now, inputs);
  const shown = shownHeadline(headline, loading, fresh);
  const announcement = useChangeAnnouncement(shown.label, !loading);
  const status: Status = shown.status;
  const notice: NoticeInputs = {
    fresh,
    failed: inputs.failed,
    servedStale: inputs.servedStale ?? false,
  };
  return (
    <Box
      component="section"
      aria-label="Overall status"
      sx={{
        bgcolor: statusVar(status, "tint"),
        border: `1px solid ${statusVar(status, "fill")}`,
        borderRadius: CARD_RADIUS,
        p: { xs: 2.5, sm: 3 },
      }}
    >
      <Stack direction="row" spacing={1.5} sx={{ alignItems: "center" }}>
        <StatusIcon status={status} size={30} />
        <Typography
          component="h1"
          ref={heading}
          tabIndex={-1}
          // Layout waits for a settled h1 before moving focus to it after a navigation.
          data-settled={loading ? "false" : "true"}
          sx={{
            fontSize: { xs: "1.375rem", sm: "1.75rem" },
            lineHeight: 1.2,
            fontWeight: 600,
            color: statusVar(status, "fg"),
          }}
        >
          <HeadingText subject={subject} alias={alias} label={shown.label} />
        </Typography>
      </Stack>
      <Detail headline={shown} />
      {/* The secondary line describes the data, so it goes when the headline does. */}
      <Line text={loading || fresh.unavailable ? undefined : secondary} />
      <AgeLine fresh={fresh} someLate={someLate} />
      <Notice
        text={noticeText(notice, inputs.lastSuccessAt !== null, loading ? [] : notes)}
        announcement={announcement}
      />
    </Box>
  );
}

type NamedLine = DetailLine & { status: Status };

/**
 * The line under the headline: one paragraph, or, when it names more than one
 * status, a short list with each status's icon and then the rest.
 */
function Detail({ headline }: { headline: Headline }) {
  const { detail, lines } = headline;
  if (lines === undefined) return <Line text={detail} />;
  const named = lines.filter((l): l is NamedLine => l.status !== null);
  const rest = lines.filter((l) => l.status === null).map((l) => l.text);
  return (
    <>
      <Box component="ul" sx={{ m: 0, mt: 0.75, p: 0, listStyle: "none" }}>
        {named.map((l) => (
          <Stack
            key={l.text}
            component="li"
            direction="row"
            spacing={0.75}
            sx={{ alignItems: "flex-start", "& + li": { mt: 0.5 } }}
          >
            <Box sx={{ display: "inline-flex", flexShrink: 0, mt: "2px" }}>
              <StatusIcon status={l.status} size={16} />
            </Box>
            <Typography variant="body2">{l.text}</Typography>
          </Stack>
        ))}
      </Box>
      <Line text={rest.length > 0 ? rest.join(" ") : undefined} />
    </>
  );
}

function Line({ text }: { text: string | undefined }) {
  if (text === undefined) return null;
  return (
    <Typography variant="body2" sx={{ mt: 0.75 }}>
      {text}
    </Typography>
  );
}
