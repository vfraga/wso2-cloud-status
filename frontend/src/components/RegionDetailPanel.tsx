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
import type { Location, RegionDetail } from "../api/types";
import { useAutoExpanded } from "../hooks/useAutoExpanded";
import { shortName } from "../lib/regions";
import { STATUS_LABEL } from "../lib/status";
import { StatusLabel } from "./StatusIcon";
import { UptimeList } from "./UptimeList";

const regionNameSx = { fontSize: "1rem", fontWeight: 600 } as const;

/** The heading level of a region: h3 on its own, h4 under its location. Its groups are one below. */
type Level = 3 | 4;
const heading = (level: number) => `h${String(level)}` as "h3" | "h4" | "h5";

/** A region with nothing to expand shows its name as plain text, never an empty panel. */
function RegionName({
  region,
  name,
  level,
  expanded,
  panelId,
  onToggle,
}: {
  region: RegionDetail;
  name: string;
  level: Level;
  expanded: boolean;
  panelId: string;
  onToggle: () => void;
}) {
  if (region.groups.length === 0) {
    return (
      <Typography component={heading(level)} sx={regionNameSx}>
        {name}
      </Typography>
    );
  }
  return (
    <Typography component={heading(level)} sx={regionNameSx}>
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
        {name}
      </Button>
    </Typography>
  );
}

export function RegionDetailPanel({
  region,
  name = region.name,
  level = 3,
}: {
  region: RegionDetail;
  /** Shown name: the short one under a location ("Data plane"). */
  name?: string;
  level?: Level;
}) {
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
          name={name}
          level={level}
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
            <Typography component={heading(level + 1)} variant="body2" sx={{ fontWeight: 700 }}>
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

/**
 * A location (US) with its parts as h4 panels under its h3 name and status.
 * The parts are listed, never folded away: the page is about this product.
 */
export function LocationPanel({
  location,
  regions,
}: {
  location: Location;
  regions: readonly RegionDetail[];
}) {
  return (
    <Box
      component="li"
      sx={{ listStyle: "none", pt: 1.5, borderTop: "1px solid var(--cs-border)" }}
    >
      <Stack
        direction="row"
        useFlexGap
        sx={{ justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 1 }}
      >
        <Typography component="h3" sx={{ fontSize: "1.125rem", fontWeight: 600 }}>
          {location.name}
        </Typography>
        <StatusLabel status={location.status}>{STATUS_LABEL[location.status]}</StatusLabel>
      </Stack>
      <Box component="ul" sx={{ m: 0, mt: 0.5, p: 0, pl: 2 }}>
        {regions.map((region) => (
          <RegionDetailPanel
            key={region.id}
            region={region}
            name={shortName(region, location)}
            level={4}
          />
        ))}
      </Box>
    </Box>
  );
}
