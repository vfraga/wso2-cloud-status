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

import { Link as MuiLink } from "@wso2/oxygen-ui";
import { ExternalLink } from "@wso2/oxygen-ui-icons-react";
import type { ReactNode } from "react";

interface ExternalAnchorProps {
  href: string;
  /** Accessible name; must contain the visible text. */
  label: string;
  children: ReactNode;
  weight?: number;
  /**
   * A link inside a sentence flows with the text. WCAG 2.5.8 exempts such
   * links, and a 24 px box would push its line apart.
   */
  inline?: boolean;
}

const blockSx = { display: "inline-flex", alignItems: "center", gap: 0.5, minHeight: 24 } as const;
const inlineSx = { display: "inline", "& svg": { ml: 0.5, verticalAlign: "-2px" } } as const;

/**
 * A link to another site, marked with an icon and an accessible name. It
 * takes the text colour and an underline, so it never reads as a status
 * colour. On its own it is at least 24 px tall, so links that wrap onto
 * several lines on a phone keep the WCAG 2.2 minimum target size (SC 2.5.8).
 */
export function ExternalAnchor({
  href,
  label,
  children,
  weight = 400,
  inline = false,
}: ExternalAnchorProps) {
  return (
    <MuiLink
      href={href}
      variant="body2"
      underline="always"
      aria-label={label}
      sx={{
        ...(inline ? inlineSx : blockSx),
        color: "var(--cs-text)",
        // MUI tints the underline with the theme's primary colour (orange).
        textDecorationColor: "currentColor",
        fontWeight: weight,
      }}
    >
      {children}
      <ExternalLink aria-hidden="true" size={14} />
    </MuiLink>
  );
}
