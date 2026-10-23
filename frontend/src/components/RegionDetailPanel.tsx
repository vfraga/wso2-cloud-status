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

import { Box, Button, Collapse, Stack, Typography } from "@wso2/oxygen-ui";
import { ChevronDown } from "@wso2/oxygen-ui-icons-react";
import { useId } from "react";
import type { RegionDetail } from "../api/types";
import { useAutoExpanded } from "../hooks/useAutoExpanded";
import { STATUS_LABEL } from "../lib/status";
import { StatusLabel } from "./StatusIcon";
import { UptimeList } from "./UptimeList";

const regionNameSx = { fontSize: "1rem", fontWeight: 600 } as const;

/** A region with nothing to expand shows its name as plain text, never an empty panel. */
function RegionName({
  region,
  expanded,
  panelId,
  onToggle,
}: {
  region: RegionDetail;
  expanded: boolean;
  panelId: string;
  onToggle: () => void;
}) {
  if (region.groups.length === 0) {
    return (
      <Typography component="h3" sx={regionNameSx}>
        {region.name}
      </Typography>
    );
  }
  return (
    <Typography component="h3" sx={regionNameSx}>
      <Button
        variant="text"
        aria-expanded={expanded}
        // The panel unmounts when collapsed; point at it only while it exists.
        aria-controls={expanded ? panelId : undefined}
        onClick={onToggle}
        endIcon={
          <ChevronDown
            aria-hidden="true"
            size={16}
            style={{ transform: expanded ? "rotate(180deg)" : "none" }}
          />
        }
        sx={{ color: "var(--cs-text)", ml: -1, textTransform: "none", ...regionNameSx }}
      >
        {region.name}
      </Button>
    </Typography>
  );
}

export function RegionDetailPanel({ region }: { region: RegionDetail }) {
  const [expanded, setExpanded] = useAutoExpanded(region.status !== "operational");
  const panelId = useId();
  return (
    <Box
      component="li"
      sx={{ listStyle: "none", py: 1.5, borderTop: "1px solid var(--cs-border)" }}
    >
      <Stack
        direction="row"
        useFlexGap
        sx={{ justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 1 }}
      >
        <RegionName
          region={region}
          expanded={expanded}
          panelId={panelId}
          onToggle={() => {
            setExpanded(!expanded);
          }}
        />
        <StatusLabel status={region.status}>{STATUS_LABEL[region.status]}</StatusLabel>
      </Stack>
      <UptimeList uptime={region.uptime} label={`Uptime for ${region.name}`} />
      {region.groups.length === 0 && region.status === "unknown" && (
        <Typography variant="body2" sx={{ color: "var(--cs-muted)", mt: 0.5 }}>
          No component data is available right now.
        </Typography>
      )}
      <Collapse in={expanded && region.groups.length > 0} id={panelId} unmountOnExit>
        {region.groups.map((group) => (
          <Box key={group.name} sx={{ mt: 2 }}>
            <Typography component="h4" variant="body2" sx={{ fontWeight: 700 }}>
              {group.name}
            </Typography>
            <Box component="ul" sx={{ m: 0, p: 0 }}>
              {group.components.map((component) => (
                <Stack
                  key={component.name}
                  component="li"
                  direction="row"
                  useFlexGap
                  sx={{
                    listStyle: "none",
                    justifyContent: "space-between",
                    flexWrap: "wrap",
                    gap: 1,
                    py: 0.75,
                    borderTop: "1px solid var(--cs-border)",
                  }}
                >
                  <Box sx={{ minWidth: 0, flex: "1 1 240px" }}>
                    <Typography variant="body2" sx={{ fontWeight: 500 }}>
                      {component.name}
                    </Typography>
                    {component.description !== undefined && (
                      <Typography variant="caption" sx={{ color: "var(--cs-muted)" }}>
                        {component.description}
                      </Typography>
                    )}
                    {component.message !== undefined && (
                      <Typography variant="caption" component="p" sx={{ m: 0 }}>
                        {component.message}
                      </Typography>
                    )}
                  </Box>
                  <Stack sx={{ alignItems: { xs: "flex-start", sm: "flex-end" }, gap: 0.25 }}>
                    <StatusLabel status={component.status}>
                      {STATUS_LABEL[component.status]}
                    </StatusLabel>
                    <UptimeList
                      uptime={component.uptime}
                      label={`Uptime for ${component.name}`}
                      short
                    />
                  </Stack>
                </Stack>
              ))}
            </Box>
          </Box>
        ))}
      </Collapse>
    </Box>
  );
}
