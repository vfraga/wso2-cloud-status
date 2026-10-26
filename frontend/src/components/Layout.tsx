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
  Container,
  IconButton,
  Link as MuiLink,
  Stack,
  Typography,
  useColorScheme,
} from "@wso2/oxygen-ui";
import { Moon, Sun } from "@wso2/oxygen-ui-icons-react";
import { useCallback, useEffect, useRef, type ReactNode } from "react";
import { ViewFocus } from "../hooks/useViewFocus";
import { knownProduct, PRODUCT_LEGAL } from "../lib/fallbackProducts";
import { Link, matchRoute, usePathname } from "../lib/router";
import { FOOTER_TIMES, PRIVACY_POLICY, TERMS_OF_USE } from "../lib/status";
import { CARD_RADIUS } from "../theme/shape";
import { Wso2Logo } from "./Wso2Logo";

/** WSO2's legal pages, as every WSO2 status page links them. */
const LEGAL_LINKS = [
  { text: PRIVACY_POLICY, href: "https://wso2.com/privacy-policy" },
  { text: "Cookie policy", href: "https://wso2.com/cookie-policy" },
  { text: TERMS_OF_USE, href: "https://wso2.com/terms-of-use" },
  { text: "Modern slavery statement", href: "https://wso2.com/modern-slavery-statement" },
  {
    text: "Do not sell my personal information",
    href: "https://wso2.com/california-privacy#opt-out",
  },
] as const;

/**
 * Legal links in the footer's own colour, underlined. Each is at least 24 px
 * tall (WCAG 2.5.8), as they wrap onto several lines on a phone. A product's
 * page adds a row of the product's own, led by its name.
 */
function LegalLinks({
  label,
  lead,
  links,
}: {
  label: string;
  lead?: string;
  links: readonly { text: string; href: string }[];
}) {
  return (
    <Stack
      component="nav"
      aria-label={label}
      direction="row"
      useFlexGap
      sx={{
        flexWrap: "wrap",
        justifyContent: "center",
        alignItems: "center",
        columnGap: 2,
        rowGap: 0,
        mb: 1,
      }}
    >
      {lead !== undefined && <Typography variant="caption">{lead}</Typography>}
      {links.map((link) => (
        <MuiLink
          key={link.href}
          href={link.href}
          variant="caption"
          underline="always"
          sx={{
            display: "inline-flex",
            alignItems: "center",
            minHeight: 24,
            color: "inherit",
            textDecorationColor: "currentColor",
          }}
        >
          {link.text}
        </MuiLink>
      ))}
    </Stack>
  );
}

/** On a product's page, its own privacy policy and terms of use. */
function ProductLegalLinks() {
  const route = matchRoute(usePathname());
  const product = route.name === "product" ? knownProduct(route.id) : undefined;
  const legal = product === undefined ? undefined : PRODUCT_LEGAL[product.id];
  if (product === undefined || legal === undefined) return null;
  return (
    <LegalLinks
      label={`${product.name} legal`}
      lead={`${product.name}:`}
      links={[
        { text: PRIVACY_POLICY, href: legal.privacy },
        { text: TERMS_OF_USE, href: legal.terms },
      ]}
    />
  );
}

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
              <Stack
                component="span"
                direction="row"
                sx={{ alignItems: "center", gap: { xs: 1.25, sm: 1.5 } }}
              >
                {/* 36 px tall on a wide screen: the brand's digital minimum. */}
                <Wso2Logo height={{ xs: 28, sm: 36 }} />
                <Box
                  component="span"
                  aria-hidden="true"
                  sx={{ width: "1px", height: "1.5em", bgcolor: "var(--cs-border)" }}
                />
                <Typography
                  component="span"
                  sx={{ fontSize: { xs: "1.0625rem", sm: "1.25rem" }, fontWeight: 500 }}
                >
                  Cloud Status
                </Typography>
              </Stack>
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
            textAlign: "center",
          }}
        >
          <ProductLegalLinks />
          <LegalLinks label="Legal" links={LEGAL_LINKS} />
          <Typography variant="caption" component="p">
            {FOOTER_TIMES} Each product keeps its full history on its own status page.
          </Typography>
          <Typography variant="caption" component="p">
            Copyright {new Date().getFullYear()} WSO2 LLC.
          </Typography>
        </Container>
      </Box>
    </ViewFocus.Provider>
  );
}
