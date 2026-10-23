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

import { Box, Container, IconButton, Stack, Typography, useColorScheme } from "@wso2/oxygen-ui";
import { Moon, Sun } from "@wso2/oxygen-ui-icons-react";
import { useCallback, useEffect, useRef, type ReactNode } from "react";
import { ViewFocus } from "../hooks/useViewFocus";
import { Link, usePathname } from "../lib/router";
import { FOOTER_TIMES } from "../lib/status";
import { CARD_RADIUS } from "../theme/shape";

function useResolvedMode(): { dark: boolean; set: (mode: "light" | "dark") => void } {
  const { mode, systemMode, setMode } = useColorScheme();
  const resolved = mode === "system" ? systemMode : mode;
  return { dark: resolved === "dark", set: setMode };
}

function ThemeToggle() {
  const { dark, set } = useResolvedMode();
  return (
    <IconButton
      aria-label={dark ? "Switch to light mode" : "Switch to dark mode"}
      onClick={() => {
        set(dark ? "light" : "dark");
      }}
      sx={{
        color: "var(--cs-text)",
        border: "1px solid var(--cs-border)",
        borderRadius: CARD_RADIUS,
      }}
    >
      {dark ? <Sun aria-hidden="true" size={18} /> : <Moon aria-hidden="true" size={18} />}
    </IconButton>
  );
}

/**
 * After an in-page navigation (a link or the browser's back button), focus
 * moves to the new view's h1, so a screen reader announces it. A view whose
 * h1 is still loading (data-settled="false") is focused when it reports its
 * data or its failure through the returned callback, so the announcement is
 * the status, not "Checking status". Focus is not taken from an element the
 * reader moved to in the meantime. The first load leaves focus where the
 * browser put it.
 */
function useFocusOnNavigation(): (heading: HTMLElement | null) => void {
  const path = usePathname();
  const previous = useRef(path);
  const pending = useRef<{ from: Element | null } | null>(null);
  useEffect(() => {
    if (previous.current === path) return;
    previous.current = path;
    const heading = document.querySelector<HTMLElement>("main h1");
    if (heading && heading.dataset.settled !== "false") {
      pending.current = null;
      // A new view starts at the top already (navigate); Back keeps the browser's scroll.
      heading.focus({ preventScroll: true });
    } else {
      pending.current = { from: document.activeElement };
    }
  }, [path]);
  return useCallback((heading: HTMLElement | null) => {
    const wait = pending.current;
    if (wait === null || heading === null) return;
    pending.current = null;
    const active = document.activeElement;
    if (active === null || active === document.body || active === wait.from) {
      heading.focus({ preventScroll: true });
    }
  }, []);
}

export function Layout({ children }: { children: ReactNode }) {
  const settle = useFocusOnNavigation();
  return (
    <ViewFocus.Provider value={settle}>
      <Box sx={{ minHeight: "100vh", display: "flex", flexDirection: "column" }}>
        <Container
          maxWidth={false}
          sx={{ maxWidth: 880, px: { xs: "20px !important", sm: "24px !important" } }}
        >
          <Stack
            component="header"
            direction="row"
            sx={{
              justifyContent: "space-between",
              alignItems: "center",
              pt: { xs: 2.5, sm: 3 },
              pb: { xs: 3, sm: 4 },
            }}
          >
            <Link to="/" style={{ textDecoration: "none" }} aria-label="WSO2 Cloud Status, home">
              <Typography component="span" sx={{ fontSize: "1.125rem", letterSpacing: "-0.01em" }}>
                <strong>WSO2</strong> Cloud Status
              </Typography>
            </Link>
            <ThemeToggle />
          </Stack>
        </Container>
        <Container
          component="main"
          maxWidth={false}
          sx={{
            maxWidth: 880,
            px: { xs: "20px !important", sm: "24px !important" },
            flex: 1,
            pb: 8,
          }}
        >
          {children}
        </Container>
        <Container
          component="footer"
          maxWidth={false}
          sx={{
            maxWidth: 880,
            px: { xs: "20px !important", sm: "24px !important" },
            pb: 5,
            color: "var(--cs-muted)",
          }}
        >
          <Typography variant="caption" component="p">
            {FOOTER_TIMES} Each product keeps its full history on its own status page.
          </Typography>
          <Typography variant="caption" component="p">
            Copyright 2026 WSO2 LLC.
          </Typography>
        </Container>
      </Box>
    </ViewFocus.Provider>
  );
}
