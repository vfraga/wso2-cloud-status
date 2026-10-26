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

import { Box, Stack, Tooltip, Typography } from "@wso2/oxygen-ui";
import { useEffect, useRef, useState } from "react";
import type { Status } from "../api/types";
import { DAY_LABEL, LEGEND_DESCRIPTION, LEGEND_INTRO, LEGEND_NO_DATA } from "../lib/status";
import { CARD_RADIUS } from "../theme/shape";
import { dayFill } from "./dayFill";

/** Worst first, then a quiet day and a day without data. */
const ENTRIES: readonly Status[] = ["outage", "degraded", "maintenance", "operational", "unknown"];

/**
 * Drawn like a strip cell, at its height for the status, and centred on the
 * text line.
 */
function Swatch({ status }: { status: Status }) {
  return (
    <Box
      aria-hidden="true"
      sx={{
        display: "inline-block",
        width: 8,
        height: 16,
        borderRadius: "1px",
        flexShrink: 0,
        ...dayFill(status),
      }}
    />
  );
}

/** The strip's tooltip look: a card in the surface colour. */
const tipSx = {
  bgcolor: "var(--cs-surface)",
  color: "var(--cs-text)",
  border: "1px solid var(--cs-border)",
  borderRadius: CARD_RADIUS,
  boxShadow: "0 6px 24px rgb(0 0 0 / 0.18)",
  px: 1.5,
  py: 1,
  maxWidth: 300,
  fontSize: "0.875rem",
  fontWeight: 400,
  lineHeight: 1.43,
} as const;

/**
 * One colour and its name, as a button that shows what it means. Its
 * description opens on hover, on keyboard focus, on Enter or Space and on a
 * tap, can be hovered, and closes on Escape (WCAG 1.4.13); a screen reader
 * hears it as the button's description. A tap opens it at once and keeps it
 * open until the reader taps elsewhere or presses Escape: nothing else a
 * touch screen sends (the tooltip's own touch timer, emulated mouse events, a
 * blur) closes it before it can be read.
 */
function Entry({ status }: { status: Status }) {
  const [open, setOpen] = useState(false);
  const byTouch = useRef(false);
  const entry = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!open) return undefined;
    const away = (event: PointerEvent): void => {
      if (entry.current?.contains(event.target as Node)) return;
      byTouch.current = false;
      setOpen(false);
    };
    document.addEventListener("pointerdown", away);
    return () => {
      document.removeEventListener("pointerdown", away);
    };
  }, [open]);
  return (
    <Tooltip
      title={LEGEND_DESCRIPTION[status]}
      describeChild
      open={open}
      onOpen={() => {
        setOpen(true);
      }}
      onClose={(event) => {
        if (byTouch.current && event.type !== "keydown") return;
        byTouch.current = false;
        setOpen(false);
      }}
      disableTouchListener
      placement="top"
      slotProps={{ tooltip: { sx: tipSx } }}
    >
      <Stack
        ref={entry}
        component="button"
        type="button"
        direction="row"
        useFlexGap
        onPointerDown={(event) => {
          byTouch.current = event.pointerType === "touch";
          if (byTouch.current) setOpen(true);
        }}
        onClick={() => {
          setOpen(true);
        }}
        sx={{
          alignItems: "center",
          gap: 0.75,
          cursor: "help",
          // A button that reads as the legend text around it.
          font: "inherit",
          color: "inherit",
          background: "none",
          border: 0,
          p: 0,
          minHeight: 24,
        }}
      >
        <Swatch status={status} />
        <span>{status === "unknown" ? LEGEND_NO_DATA : DAY_LABEL[status]}</span>
      </Stack>
    </Tooltip>
  );
}

/**
 * Under the strips, centred: what a bar is, then what each colour means,
 * drawn with the same marks, so a grey "No data" day is not read as an outage.
 */
export function HistoryLegend() {
  return (
    <Typography
      component="div"
      variant="caption"
      sx={{ mt: 1.5, color: "var(--cs-muted)", textAlign: "center" }}
    >
      <div>{LEGEND_INTRO}</div>
      <Box
        sx={{
          display: "flex",
          flexWrap: "wrap",
          justifyContent: "center",
          alignItems: "center",
          columnGap: 2,
          rowGap: 0.5,
          mt: 0.5,
        }}
      >
        {ENTRIES.map((status) => (
          <Entry key={status} status={status} />
        ))}
      </Box>
    </Typography>
  );
}
