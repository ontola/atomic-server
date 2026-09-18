# Clockify on LocalThought

Retire the server-side Clockify plugin (issue #1534) and rebuild Clockify as a
browser-only LocalThought extension, applying the `clockify-ui/` mockups.
Decisions (2026-09-18): build on LocalThought and delete the server plugin;
close the workspace/user picker gap; keep two-way affordances visible but
disabled; accept Project/Person linking and legacy-install migration as v1
reductions (old tables stay readable, no automatic migration).

## Phase 1 — LocalThought extension, old plugin removed

- [x] `integrations/clockify/localthought.ts`: projection of `timeentry`
      records into Time Tracker-shaped terms (start/end timestamps, billable,
      description as name, running timers and breaks skipped), rolling
      date-range query overrides (`start`/`end` on the list operation).
- [x] Generic `LocalThoughtExtension` interface in `localThoughtExtension.ts`
      with a `clockify` mode; registry keyed by platform.
- [x] `ensureImportTables` builds a `timer` view (start/end, derived Duration,
      day breakdown with summed Duration) when the extension asks for one.
- [x] Workspace/user picker via `PARAMETER_OPTION_LOOKUPS` (`/v1/workspaces`,
      `/v1/user`), with human labels for the parameters.
- [x] `catalog.json`: Clockify entry becomes a LocalThought platform entry.
- [x] Remove `integrations/clockify/{plugin,model,atomic}.*`, the server
      sandbox tests, `ConnectClockify`, `ClockifyUpgrade`, the lib Store
      integration test, e2e plugin tests, evidence entry.

## Phase 2 — mockups

- [x] Setup stepper (Connect → Choose what to sync → Import) around the
      LocalThought dialog for Clockify, with the connected-account card,
      workspace/range fields, and a disabled two-way direction option.
- [x] Manage panel on the folder/table: status tiles, settings (direction and
      schedule shown disabled), field mapping, connection card, recent runs.
- [x] Time entries view: sync header with "Open in Clockify"; day totals via
      the timer view's breakdown.
- [ ] Row menu and entry editor with the two-way items (push, discard,
      delete in Clockify, per-entry Clockify block): these live in the
      generic table's row menu and resource editor, so they wait for two-way
      sync rather than adding disabled provider-specific items there.

## Verification

- `browser/e2e/tests/clockify-import.spec.ts` runs the whole flow against
  `integrations/localthought/mock-proxy.mjs` (synthetic Clockify fixture in
  `mock-clockify.mjs`): consent, PKCE, pickers, bounded fetch, Timer view,
  Manage panel, look-back change, scheduled refresh, failure and recovery,
  with every server plugin endpoint blocked.
- Live verification against localthought.io needs the user's own sign-in.

## Not in scope

- Two-way sync, push/conflict resolution, tags column, per-entry deep links.
- Project/Person linked records; Clockify only returns raw ids on entries.
- Regional/private API origins.
