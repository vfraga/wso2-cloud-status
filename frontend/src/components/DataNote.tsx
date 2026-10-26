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
import type { ReactNode } from "react";

interface DataNoteProps {
  /** A 14 px icon, hidden from assistive technology. */
  icon: ReactNode;
  children: ReactNode;
}

/** A note about the data shown, with an icon and body text, so it is not mistaken for fine print. */
export function DataNote({ icon, children }: DataNoteProps) {
  return (
    <Stack
      direction="row"
      spacing={0.75}
      sx={{
        alignItems: "flex-start",
        color: "var(--cs-text)",
      }}
    >
      <Box sx={{ display: "inline-flex", flexShrink: 0, mt: "3px" }}>{icon}</Box>
      <Typography variant="body2">{children}</Typography>
    </Stack>
  );
}
