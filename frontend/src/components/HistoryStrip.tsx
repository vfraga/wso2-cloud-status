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

import {
  Box,
  Button,
  Collapse,
  Popper,
  Stack,
  Typography,
  type PopperProps,
} from "@wso2/oxygen-ui";
import { ChevronDown } from "@wso2/oxygen-ui-icons-react";
import { useEffect, useId, useRef, useState, type KeyboardEvent, type Ref } from "react";
import type { Day, Incident } from "../api/types";
import { usePageNow } from "../hooks/useNow";
import { useVisibleDays } from "../hooks/useVisibleDays";
import {
  dayAriaLabel,
  dayDetail,
  historyText,
  stripCaptions,
  summariseHistory,
  type DayDetail,
} from "../lib/history";
import { DAY_LABEL, daysWithIncidents, isProblem } from "../lib/status";
import { utcDayKey } from "../lib/time";
import { CARD_RADIUS } from "../theme/shape";
import { dayFill, dayFocusSx } from "./dayFill";
import { StatusLabel } from "./StatusIcon";

interface HistoryStripProps {
  productName: string;
  /** All days the API sent, oldest first; the strip shows the most recent that fit. */
  days: readonly Day[];
  incidents: ReadonlyMap<string, Incident>;
  /** When the product's incident data stopped answering, its last successful fetch. */
  completeUntil?: Date | null;
}

/** How long the tooltip stays after the pointer leaves the strip, so it can move onto the tooltip. */
const CLOSE_DELAY_MS = 120;

/**
 * Below the strip, so it never covers the row's own name and status above
 * it. It flips above only at the end of the document, not of the screen: near
 * the bottom of the screen it still opens below, and a tooltip opened by a
 * tap or the keyboard is scrolled into view (see useTip). A constant, so the
 * Popper is not rebuilt on every render.
 */
const TIP_MODIFIERS: NonNullable<PopperProps["modifiers"]> = [
  { name: "offset", options: { offset: [0, 8] } },
  { name: "flip", options: { fallbackPlacements: ["top"], rootBoundary: "document" } },
  { name: "preventOverflow", options: { padding: 8 } },
];

function cellSx(status: Day["status"]) {
  return {
    height: { xs: 28, sm: 32 },
    borderRadius: "2px",
    minWidth: 0,
    cursor: "default",
    "&:hover": { filter: "brightness(0.9)" },
    ...dayFocusSx,
    // The cell keeps its full height for pointing and focus; dayFill draws the day.
    ...dayFill(status),
  };
}

function DayContent({ detail }: { detail: DayDetail }) {
  return (
    <>
      {/* The date and its status share a line, wrapping when the space is narrow. */}
      <Stack
        direction="row"
        useFlexGap
        sx={{ flexWrap: "wrap", alignItems: "center", columnGap: 1.5, rowGap: 0.25 }}
      >
        <Typography variant="body2" sx={{ fontWeight: 700 }}>
          {detail.heading}
        </Typography>
        <StatusLabel status={detail.status}>{detail.statusLabel}</StatusLabel>
      </Stack>
      {detail.minutes.map((m) => (
        <Typography key={m.label} variant="body2" sx={{ color: "var(--cs-muted)" }}>
          {m.label}: {m.text}
        </Typography>
      ))}
      {detail.titles.length > 0 && (
        <Box component="ul" sx={{ m: 0, mt: 0.5, pl: 2 }}>
          {detail.titles.map((t) => (
            <Typography key={t} variant="body2" component="li">
              {t}
            </Typography>
          ))}
        </Box>
      )}
      {detail.note !== null && (
        <Typography variant="body2" sx={{ mt: 0.5 }}>
          {detail.note}
        </Typography>
      )}
    </>
  );
}

interface TooltipBodyProps {
  detail: DayDetail;
  onMouseEnter: () => void;
  onMouseLeave: () => void;
  ref: Ref<HTMLDivElement>;
}

/** Hoverable (WCAG 1.4.13): the pointer can move onto it without closing it. */
function TooltipBody({ detail, onMouseEnter, onMouseLeave, ref }: TooltipBodyProps) {
  return (
    <Box
      ref={ref}
      aria-hidden="true"
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
      sx={{
        bgcolor: "var(--cs-surface)",
        color: "var(--cs-text)",
        border: "1px solid var(--cs-border)",
        borderRadius: CARD_RADIUS,
        boxShadow: "0 6px 24px rgb(0 0 0 / 0.18)",
        px: 1.5,
        py: 1,
        maxWidth: 300,
      }}
    >
      <DayContent detail={detail} />
    </Box>
  );
}

function nextIndex(key: string, current: number, last: number): number | null {
  switch (key) {
    case "ArrowLeft":
      return Math.max(0, current - 1);
    case "ArrowRight":
      return Math.min(last, current + 1);
    case "Home":
      return 0;
    case "End":
      return last;
    default:
      return null;
  }
}

interface CaptionsProps {
  days: readonly Day[];
  today: string;
  productName: string;
  open: boolean;
  listId: string;
  onToggle: () => void;
}

/**
 * The first day's date, the number of days with incidents and "Today". With
 * incidents, the count is a button that lists those days: the same details
 * as the cells, through a control large enough to use on a phone (WCAG
 * 2.5.8), where a cell is about 8 px wide.
 */
function Captions({ days, today, productName, open, listId, onToggle }: CaptionsProps) {
  const [from, to] = stripCaptions(days, today);
  const { withIncidents, withoutData } = summariseHistory(days);
  const caption = { color: "var(--cs-muted)", whiteSpace: "nowrap" } as const;
  // The row wraps rather than overflow its card when text spacing grows (WCAG 1.4.12);
  // the end caption keeps to the right, under the end of the strip.
  return (
    <Stack
      direction="row"
      useFlexGap
      sx={{
        justifyContent: "space-between",
        alignItems: "center",
        flexWrap: "wrap",
        columnGap: 1,
        rowGap: 0,
        mt: 0.5,
        "& > :last-child": { ml: "auto" },
      }}
    >
      <Typography variant="caption" aria-hidden="true" sx={caption}>
        {from}
      </Typography>
      {withIncidents > 0 ? (
        <Button
          variant="text"
          size="small"
          aria-expanded={open}
          aria-controls={open ? listId : undefined}
          onClick={onToggle}
          endIcon={
            <ChevronDown
              aria-hidden="true"
              size={14}
              style={{ transform: open ? "rotate(180deg)" : "none" }}
            />
          }
          sx={{
            color: "var(--cs-muted)",
            minWidth: 0,
            minHeight: 24,
            px: 0.5,
            py: 0,
            fontSize: "0.75rem",
            fontWeight: 600,
            textTransform: "none",
            "&:hover": { bgcolor: "transparent", textDecoration: "underline" },
          }}
        >
          <span>
            {daysWithIncidents(withIncidents)}{" "}
            <span className="cs-visually-hidden">{`for ${productName}`}</span>
          </span>
        </Button>
      ) : (
        <Typography variant="caption" aria-hidden="true" sx={caption}>
          {withoutData === days.length ? DAY_LABEL.unknown : daysWithIncidents(0)}
        </Typography>
      )}
      <Typography variant="caption" aria-hidden="true" sx={caption}>
        {to}
      </Typography>
    </Stack>
  );
}

/** The days with incidents, newest first, as a list. */
function ProblemDays({
  days,
  incidents,
  now,
  completeUntil,
}: {
  days: readonly Day[];
  incidents: ReadonlyMap<string, Incident>;
  now: Date;
  completeUntil: Date | null;
}) {
  const problems = days.filter((d) => isProblem(d.status)).reverse();
  return (
    <Box component="ul" sx={{ listStyle: "none", m: 0, mt: 1, p: 0 }}>
      {problems.map((day) => (
        <Box key={day.date} component="li" sx={{ py: 1, borderTop: "1px solid var(--cs-border)" }}>
          <DayContent detail={dayDetail(day, incidents, now, completeUntil)} />
        </Box>
      ))}
    </Box>
  );
}

interface Tip {
  index: number;
  anchor: HTMLElement;
  /** Opened by focus (a tap or the keyboard) rather than by hovering. */
  byFocus: boolean;
}

/**
 * Tooltip state with a short delay before closing, cancelled when the pointer
 * comes back. A tooltip opened by focus is scrolled into view once placed, so
 * one that opens below the bottom of the screen can be read; hovering never
 * moves the page.
 */
function useTip() {
  const [tip, setTip] = useState<Tip | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const body = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!tip?.byFocus) return undefined;
    // The Popper places it after this render; the next frame sees where.
    const id = requestAnimationFrame(() => {
      body.current?.scrollIntoView({ block: "nearest" });
    });
    return () => {
      cancelAnimationFrame(id);
    };
  }, [tip]);
  useEffect(() => {
    const pending = timer;
    return () => {
      clearTimeout(pending.current);
    };
  }, []);
  const open = tip !== null;
  // Escape dismisses the tooltip however it opened, hover included (WCAG 1.4.13).
  useEffect(() => {
    if (!open) return;
    const onKey = (event: globalThis.KeyboardEvent): void => {
      if (event.key !== "Escape") return;
      clearTimeout(timer.current);
      setTip(null);
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);
  const keep = (): void => {
    clearTimeout(timer.current);
  };
  return {
    tip,
    body,
    show: (index: number, anchor: HTMLElement, byFocus: boolean): void => {
      keep();
      setTip({ index, anchor, byFocus });
    },
    hide: (): void => {
      keep();
      setTip(null);
    },
    keep,
    hideSoon: (): void => {
      keep();
      timer.current = setTimeout(() => {
        setTip(null);
      }, CLOSE_DELAY_MS);
    },
  };
}

/**
 * Oldest day on the left; days are UTC calendar days. One tab stop: arrow keys
 * move focus between days and the tooltip follows focus. Each cell carries the
 * full text as its accessible name, so the tooltip is a visual duplicate.
 */
export function HistoryStrip({
  productName,
  days: allDays,
  incidents,
  completeUntil = null,
}: HistoryStripProps) {
  const visible = useVisibleDays();
  const now = usePageNow();
  const today = utcDayKey(now);
  const days = allDays.slice(-visible);
  const last = days.length - 1;
  // Focus is kept as a distance from today, so it survives a change of range.
  const [fromEnd, setFromEnd] = useState(0);
  const active = Math.max(0, last - fromEnd);
  const setActive = (index: number): void => {
    setFromEnd(last - index);
  };
  const { tip, body, show, hide, keep, hideSoon } = useTip();
  const [listOpen, setListOpen] = useState(false);
  const listId = useId();
  const cells = useRef<(HTMLDivElement | null)[]>([]);

  if (days.length === 0) return null;

  const focusCell = (index: number): void => {
    setActive(index);
    cells.current[index]?.focus();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key === "Escape") {
      hide();
      return;
    }
    const target = nextIndex(event.key, active, last);
    if (target === null) return;
    event.preventDefault();
    focusCell(target);
  };

  const tipDay = tip === null ? undefined : days[tip.index];
  const hasProblems = days.some((d) => isProblem(d.status));

  return (
    <Box sx={{ mt: 2 }}>
      <Box
        role="listbox"
        aria-orientation="horizontal"
        aria-label={`${String(days.length)}-day history for ${productName}, UTC days`}
        onKeyDown={onKeyDown}
        onMouseLeave={hideSoon}
        sx={{
          display: "grid",
          gridTemplateColumns: `repeat(${String(days.length)}, minmax(0, 1fr))`,
          gap: { xs: "1px", sm: "2px" },
        }}
      >
        {days.map((day, index) => {
          const detail = dayDetail(day, incidents, now, completeUntil);
          return (
            <Box
              key={day.date}
              ref={(el: HTMLDivElement | null) => {
                cells.current[index] = el;
              }}
              role="option"
              aria-selected={index === active}
              aria-label={dayAriaLabel(detail)}
              tabIndex={index === active ? 0 : -1}
              onFocus={(event) => {
                setActive(index);
                show(index, event.currentTarget, true);
              }}
              onBlur={hide}
              onMouseEnter={(event) => {
                show(index, event.currentTarget, false);
              }}
              sx={cellSx(day.status)}
            />
          );
        })}
      </Box>
      <span className="cs-visually-hidden">{historyText(days)}</span>
      <Captions
        days={days}
        today={today}
        productName={productName}
        open={listOpen}
        listId={listId}
        onToggle={() => {
          setListOpen(!listOpen);
        }}
      />
      <Collapse in={listOpen && hasProblems} id={listId} unmountOnExit>
        <ProblemDays days={days} incidents={incidents} now={now} completeUntil={completeUntil} />
      </Collapse>
      <Popper
        open={tipDay !== undefined}
        anchorEl={tip?.anchor ?? null}
        placement="bottom"
        modifiers={TIP_MODIFIERS}
        sx={{ zIndex: 1300 }}
      >
        {tipDay && (
          <TooltipBody
            ref={body}
            detail={dayDetail(tipDay, incidents, now, completeUntil)}
            onMouseEnter={keep}
            onMouseLeave={hideSoon}
          />
        )}
      </Popper>
    </Box>
  );
}
