Fixture variants for the end-to-end scenarios. Each directory holds only the
upstream files that differ from testdata/upstream; e2e/build-fixtures.mjs
copies the base, overlays these files, deletes the paths listed in REMOVE,
and expands time tokens:

  @@ago:90m@@        timestamp 90 minutes ago, "YYYY-MM-DD HH:MM:SS" in UTC
  @@month:ago:0m@@   month key of that instant, "YYYY-M" (no zero padding)

testdata/upstream is never modified.

Scenarios (one spec each in e2e/specs/; scripts/e2e.sh runs them in turn):

  ok         testdata/upstream, with one resolved Identity Platform outage
             10 days ago ("Sign-in errors in the EU region"), so the strips
             hold an incident day whatever the date the suite runs on
  degraded   in Bijira's EU data plane one degraded and one outage
             component, in its EU control plane one maintenance component;
             an active incident, and a resolved outage and maintenance
  stale      Moesif never answers (all three of its files removed)
  outdated   Moesif's incidents never answer (only that file removed);
             scripts/e2e.sh also shortens the polling intervals and
             stale_after, so its incidents budget of max(10s, 3 x 5s) = 15 s
             runs out soon after start
  stopped    testdata/upstream as it is, with the same short intervals; the
             spec removes moesif.incidents.json and agent-manager.monitors.json
             from E2E_FIXTURE_DIR once every source has answered, so the two
             feeds stop after answering
