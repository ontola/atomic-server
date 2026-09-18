# Clockify on LocalThought

Retire the server-side Clockify plugin (issue #1534) and rebuild Clockify as a
browser-only LocalThought extension, applying the `clockify-ui/` mockups.
Decisions (2026-09-18): build on LocalThought and delete the server plugin;
close the workspace/user picker gap; keep two-way affordances visible but
disabled; accept Project/Person linking and legacy-install migration as v1
reductions (old tables stay readable, no automatic migration).

## Phase 1 — LocalThought extension, old plugin removed

- [ ] `integrations/clockify/localthought.ts`: projection of `timeentry`
      records into Time Tracker-shaped terms (start/end timestamps, billable,
      description as name, running timers and breaks skipped), rolling
      date-range query overrides (`start`/`end` on the list operation).
- [ ] Generic `LocalThoughtExtension` interface in `localThoughtExtension.ts`
      with a `clockify` mode; registry keyed by platform.
- [ ] `ensureImportTables` builds a `timer` view (start/end, derived Duration,
      day breakdown with summed Duration) when the extension asks for one.
- [ ] Workspace/user picker via `PARAMETER_OPTION_LOOKUPS` (`/v1/workspaces`,
      `/v1/user`), with human labels for the parameters.
- [ ] `catalog.json`: Clockify entry becomes a LocalThought platform entry.
- [ ] Remove `integrations/clockify/{plugin,model,atomic}.*`, the server
      sandbox tests, `ConnectClockify`, `ClockifyUpgrade`, the lib Store
      integration test, e2e plugin tests, evidence entry.

## Phase 2 — mockups

- [ ] Setup stepper (Connect → Choose what to sync → Import) around the
      LocalThought dialog for Clockify, with the connected-account card,
      workspace/range fields, and a disabled two-way direction option.
- [ ] Manage panel on the folder/table: status tiles, settings (direction and
      schedule shown disabled), field mapping, connection card, recent runs.
- [ ] Time entries view: sync header with "Open in Clockify"; day totals via
      the timer view's breakdown; row menu with the two-way items disabled.

## Not in scope

- Two-way sync, push/conflict resolution, tags column, per-entry deep links.
- Project/Person linked records; Clockify only returns raw ids on entries.
- Regional/private API origins.
