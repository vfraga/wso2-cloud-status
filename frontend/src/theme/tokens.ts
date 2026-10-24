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

import type { Status } from "../api/types";

/*
 * Single source for every colour the page adds to the Oxygen WSO2 theme.
 * tokens.test.ts checks WCAG 2.2 contrast for each pair in both schemes.
 *
 *   fg    text and icon colour on surface, page and tint (4.5:1)
 *   fill  history cells and graphical marks on surface (3:1)
 *   tint  banner and chip background; fg must reach 4.5:1 on it
 */
interface StatusColors {
  fg: string;
  fill: string;
  tint: string;
}

export interface Palette {
  page: string;
  surface: string;
  border: string;
  text: string;
  muted: string;
  focus: string;
  status: Record<Status, StatusColors>;
}

export const LIGHT: Palette = {
  page: "#f6f7f9",
  surface: "#ffffff",
  border: "#d9dee6",
  text: "#181818",
  muted: "#4d5665",
  focus: "#0a5aa8",
  status: {
    operational: { fg: "#146c2e", fill: "#2c9a4b", tint: "#e8f5ec" },
    maintenance: { fg: "#0a5aa8", fill: "#2f7fd1", tint: "#e6f0fb" },
    degraded: { fg: "#8a5100", fill: "#c97d00", tint: "#fdf1dc" },
    outage: { fg: "#b42318", fill: "#d92d20", tint: "#fdeceb" },
    unknown: { fg: "#566070", fill: "#7d8594", tint: "#eef0f3" },
  },
};

export const DARK: Palette = {
  page: "#0f172a",
  surface: "#172238",
  border: "#2b3955",
  text: "#f1f5f9",
  muted: "#a9b4c8",
  focus: "#7cc0ff",
  status: {
    operational: { fg: "#4ade80", fill: "#34b25c", tint: "#12301f" },
    maintenance: { fg: "#7cc0ff", fill: "#4b9ae6", tint: "#14304f" },
    degraded: { fg: "#fbbf24", fill: "#e0a100", tint: "#3a2d0c" },
    outage: { fg: "#ff8f85", fill: "#ee5246", tint: "#3d1a1a" },
    unknown: { fg: "#a3aec2", fill: "#6f7b93", tint: "#222c40" },
  },
};

const STATUS_KEYS: Status[] = ["unknown", "operational", "maintenance", "degraded", "outage"];

function declarations(p: Palette): string {
  const lines = [
    `--cs-page:${p.page}`,
    `--cs-surface:${p.surface}`,
    `--cs-border:${p.border}`,
    `--cs-text:${p.text}`,
    `--cs-muted:${p.muted}`,
    `--cs-focus:${p.focus}`,
  ];
  for (const key of STATUS_KEYS) {
    const c = p.status[key];
    lines.push(
      `--cs-${key}-fg:${c.fg}`,
      `--cs-${key}-fill:${c.fill}`,
      `--cs-${key}-tint:${c.tint}`,
    );
  }
  return lines.join(";");
}

/**
 * CSS custom properties for both schemes. Before React sets
 * data-color-scheme, the operating-system preference decides.
 */
export function tokenCss(): string {
  return [
    `:root{${declarations(LIGHT)}}`,
    `@media (prefers-color-scheme: dark){:root:not([data-color-scheme="light"]){${declarations(DARK)}}}`,
    `:root[data-color-scheme="dark"]{${declarations(DARK)}}`,
  ].join("\n");
}

export const statusVar = (status: Status, part: keyof StatusColors): string =>
  `var(--cs-${status}-${part})`;
