# Clockify (LocalThought)

Clockify runs entirely in the browser through LocalThought: no AtomicServer-side
code, no stored secret, no server-initiated calls to Clockify. The personal API
key (Preferences → **Manage API keys** → **Generate new** at
https://app.clockify.me/manage-api-keys) is entered on LocalThought's consent
page and sealed into a per-connection credential by the integration proxy. The
generic Syncables engine pages through `timeEntries` from the proxy's Clockify
catalog document; `localthought.ts` here is the only Clockify-specific code.

## What the lens does

- **Workspace and account picker.** The catalog document only lists time
  entries, so setup reads `/v1/workspaces` and `/v1/user` through the same
  proxy (`parameterOptions.ts`) and offers them as dropdowns; the account is
  filled in automatically since there is only one.
- **Rolling look-back.** Setup offers the past 7 or 30 days. The window is
  recomputed as `start`/`end` query overrides on every refresh, not frozen at
  installation.
- **Time Tracker projection.** Each completed `REGULAR` entry gets typed
  `start`/`end` timestamps and is named after its description. Running timers
  (no end) and breaks are skipped; the table's own timer owns anything without
  an end. Provider fields stay on the record.
- **Timer view.** The folder's table opens in a Timer view with a derived
  Duration, per-day totals and an "All entries" list — the same views the
  built-in Time Tracker template creates.

Refresh, conflict handling, limits and storage follow the generic LocalThought
flow (see `../localthought/README.md`): import only, local edits preserved,
nothing written back to Clockify.

## Not covered (v1 reductions, see `planning/clockify.md`)

- Project and Person linked records: Clockify only returns raw `projectId` /
  `userId` strings on entries.
- Tags, tasks, rates, custom fields, active timers; regional/private API
  origins.
- Automatic migration of tables created by the retired server-side plugin.
  They stay readable; reconnect through the Integrations page to start a
  LocalThought folder.

Live account data must never be checked into fixtures.
