# WSO2 Cloud Status, alert rules

Prometheus alerting rules for statusd (`prometheus-rules.yaml`) and their unit tests
(`prometheus-rules.test.yaml`).

## What the rules assume

- Prometheus scrapes every statusd replica as `job="statusd"`, on statusd's admin port
  (`:9090/metrics`), which the ingress does not expose. Each replica is its own
  `instance`; most rules alert per instance.
- The metric names are statusd's (`backend/go/internal/telemetry`). A test there
  (`TestAlertRulesMatchTheExporter`) fails when a rule reads a metric or label statusd
  does not export, so a renamed metric cannot leave an alert that never fires.
- The staleness thresholds (5 minutes for components and incidents, 15 for uptime) copy
  the shipped configuration's; a Go test
  (`TestCopiesOfTheStalenessMatchTheShippedConfiguration`) fails when they differ.
- Each alert's `runbook_url` is `docs/operations/runbook.md#<alert name in lower case>`,
  the runbook's path in the repository that holds it; the deployment that loads the
  rules prefixes that repository's address.

## Severities

`critical` pages: statusd down or missing, the published snapshot stale, more than half
the products without a known status for 5 minutes, and the origin lock off. `warning`
covers the rest: fewer products without a known status, a failing source, incomplete
data, error rates, latency, load shedding and a rejected configuration reload.

## Test

```sh
make rules        # promtool check rules, then the unit tests (Docker)
```

Each alert is checked just before and just after its `for:` duration.
