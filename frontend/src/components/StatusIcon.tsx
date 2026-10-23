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

import { Typography } from "@wso2/oxygen-ui";
import {
  CircleCheck,
  CircleHelp,
  CircleX,
  TriangleAlert,
  Wrench,
} from "@wso2/oxygen-ui-icons-react";
import type { ReactNode } from "react";
import type { Status } from "../api/types";
import { statusVar } from "../theme/tokens";

const ICONS = {
  operational: CircleCheck,
  maintenance: Wrench,
  degraded: TriangleAlert,
  outage: CircleX,
  unknown: CircleHelp,
} as const;

export function StatusIcon({ status, size = 18 }: { status: Status; size?: number }) {
  const Icon = ICONS[status];
  return (
    <Icon
      aria-hidden="true"
      size={size}
      strokeWidth={2.25}
      style={{ color: statusVar(status, "fg"), flexShrink: 0 }}
    />
  );
}

/**
 * Icon plus text, so a status is never carried by colour alone. It is body2
 * text with the icon centred on the line, so it sits on the same text line as
 * neighbouring body2 text.
 */
export function StatusLabel({ status, children }: { status: Status; children: ReactNode }) {
  return (
    <Typography
      component="span"
      variant="body2"
      sx={{
        display: "inline-flex",
        alignItems: "center",
        gap: 0.75,
        color: statusVar(status, "fg"),
        fontWeight: 600,
      }}
    >
      <StatusIcon status={status} size={16} />
      <span>{children}</span>
    </Typography>
  );
}
