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

import { Box, Button, Collapse, Typography } from "@wso2/oxygen-ui";
import { ChevronDown } from "@wso2/oxygen-ui-icons-react";
import { useId } from "react";
import type { Component, Location, RegionDetail } from "../api/types";
import { useAutoExpanded } from "../hooks/useAutoExpanded";
import { locationExtent, shortName } from "../lib/regions";
import { NO_COMPONENT_DATA, rolledUp, STATUS_LABEL } from "../lib/status";
import { StatusLabel } from "./StatusIcon";
import { GridRow, UptimeFigures, UptimeHeader } from "./Uptime";

const regionNameSx = { fontSize: "1rem", fontWeight: 600 } as const;
/** A part under its location, and a component under its part, step in; the columns do not. */
const PART_INDENT = { xs: 1.5, md: 2 } as const;
const COMPONENT_INDENT = { xs: 3, md: 4 } as const;

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
        sx={{
          color: "var(--cs-text)",
          ml: -1,
          textTransform: "none",
          // A name that wraps on a phone stays flush left.
          textAlign: "left",
          ...regionNameSx,
        }}
      >
        {name}
      </Button>
    </Typography>
  );
}

/**
 * A component on one line when it has no description: its name, its figures
 * in the shared columns, and its status. Operational shows the check alone
 * (a screen reader still hears the word); anything else says what it is.
 */
function ComponentRow({ component }: { component: Component }) {
  return (
    <Box component="li" sx={{ listStyle: "none", py: 0.625 }}>
      <GridRow
        align="start"
        name={
          <Box sx={{ pl: COMPONENT_INDENT }}>
            <Typography variant="body2">{component.name}</Typography>
            {component.description !== undefined && (
              <Typography variant="caption" component="p" sx={{ m: 0, color: "var(--cs-muted)" }}>
                {component.description}
              </Typography>
            )}
            {component.message !== undefined && (
              <Typography variant="caption" component="p" sx={{ m: 0 }}>
                {component.message}
              </Typography>
            )}
          </Box>
        }
        figures={
          <UptimeFigures
            uptime={component.uptime}
            label={`Uptime for ${component.name}`}
            kind="component"
          />
        }
        status={
          <StatusLabel status={component.status} quiet={component.status === "operational"}>
            {STATUS_LABEL[component.status]}
          </StatusLabel>
        }
      />
    </Box>
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
    <Box component="li" sx={{ listStyle: "none", py: 1, borderTop: "1px solid var(--cs-border)" }}>
      <GridRow
        name={
          <Box sx={level === 4 ? { pl: PART_INDENT } : {}}>
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
            {region.groups.length === 0 && region.status === "unknown" && (
              <Typography variant="body2" sx={{ color: "var(--cs-muted)" }}>
                {NO_COMPONENT_DATA}
              </Typography>
            )}
          </Box>
        }
        figures={
          <UptimeFigures uptime={region.uptime} label={`Uptime for ${region.name}`} kind="region" />
        }
        status={<StatusLabel status={region.status}>{STATUS_LABEL[region.status]}</StatusLabel>}
      />
      <Collapse in={expanded && region.groups.length > 0} id={panelId} unmountOnExit>
        {region.groups.map((group) => (
          <Box key={group.name} sx={{ mt: 1.5 }}>
            <Typography
              component={heading(level + 1)}
              sx={{
                pl: COMPONENT_INDENT,
                fontSize: "0.8125rem",
                fontWeight: 600,
                color: "var(--cs-muted)",
              }}
            >
              {group.name}
            </Typography>
            <Box component="ul" sx={{ m: 0, p: 0 }}>
              {group.components.map((component) => (
                <ComponentRow key={component.name} component={component} />
              ))}
            </Box>
          </Box>
        ))}
      </Collapse>
    </Box>
  );
}

/**
 * A location (US) with its parts under its h3 name and status, worded as a
 * roll-up as the home table words it; its row carries the window codes over
 * the parts' figures. The parts are listed, never folded away: the page is
 * about this product.
 */
export function LocationPanel({
  location,
  regions,
}: {
  location: Location;
  regions: readonly RegionDetail[];
}) {
  const shown = rolledUp(location.status, locationExtent(location, regions));
  return (
    <Box component="li" sx={{ listStyle: "none", pt: 2.5 }}>
      <GridRow
        name={
          <Typography component="h3" sx={{ fontSize: "1.125rem", fontWeight: 600 }}>
            {location.name}
          </Typography>
        }
        figures={<UptimeHeader />}
        status={<StatusLabel status={shown.status}>{shown.label}</StatusLabel>}
      />
      <Box component="ul" sx={{ m: 0, mt: 1, p: 0 }}>
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
