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

import { GlobalStyles, OxygenUIThemeProvider, WSO2Theme } from "@wso2/oxygen-ui";
import type { ReactNode } from "react";
import { tokenCss } from "./tokens";

// Upstream text (a URL in an incident title, a long component name) wraps
// rather than scroll the page sideways. ButtonBase sets outline: 0 and shows
// focus as a faint ripple (2:1), so buttons get the same ring as links.
// Headings take focus only after an in-page navigation, as a starting point;
// they are not controls. The string itself holds no comments: no minifier
// removes them from a string, and every reader would download them.
const globalCss = `
${tokenCss()}
html { color-scheme: light dark; }
html[data-color-scheme="light"] { color-scheme: light; }
html[data-color-scheme="dark"] { color-scheme: dark; }
body, html[data-color-scheme] body {
  background: var(--cs-page);
  background-image: none;
  color: var(--cs-text);
  margin: 0;
  font-variant-numeric: tabular-nums;
  overflow-wrap: anywhere;
}
a { color: inherit; }
:focus-visible { outline: 2px solid var(--cs-focus); outline-offset: 2px; }
.MuiButtonBase-root.Mui-focusVisible { outline: 2px solid var(--cs-focus); outline-offset: 2px; }
.MuiTouchRipple-ripplePulsate { display: none; }
h1[tabindex="-1"]:focus { outline: none; }
.cs-visually-hidden {
  position: absolute; width: 1px; height: 1px; margin: -1px; padding: 0;
  overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; border: 0;
}
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after {
    animation-duration: 0.001ms !important;
    animation-iteration-count: 1 !important;
    transition-duration: 0.001ms !important;
    scroll-behavior: auto !important;
  }
}
`;

export function ThemeRoot({ children }: { children: ReactNode }) {
  return (
    <OxygenUIThemeProvider theme={WSO2Theme}>
      <GlobalStyles styles={globalCss} />
      {children}
    </OxygenUIThemeProvider>
  );
}
