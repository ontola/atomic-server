# Clockify plugin UI proposal

Design canvas: https://claude.ai/artifact/Tv3HMhPKUiwo1LwsPP2dfj

Mockups of the synced Time Tracker table and its setup/manage screens, aiming
to offer the same information and actions as Clockify's own tracker page while
staying in the data browser's theme. Each `.dc.html` is one artboard;
`canvas.json` lays them out.

- `Main.dc.html` — Timer view: tracker bar (description, project, tags,
  billable, running clock, timer/manual), week navigator with totals, entries
  grouped per day with totals and collapsed duplicates, continue and row menu,
  per-row sync glyph, sync status header with "Open in Clockify".
- `RowMenu.dc.html` — Continue, Edit, Duplicate, Push now, Discard local
  changes, Open in Clockify, Delete.
- `Entry.dc.html` — entry editor with a here-vs-Clockify conflict banner and a
  Clockify block (entry id, last pulled/pushed, unlink).
- `Setup.dc.html` — stepper, connected account, workspace/table/range/project
  filter, import-only vs two-way choice.
- `Manage.dc.html` — status tiles, direction/schedule/look-back settings, field
  mapping table, connection card, recent runs, totals check.

Assumptions: pending-push/conflict states and push/delete-in-Clockify actions
need two-way sync (still open in `../clockify.md`); tags need a multi-select
column on the Time Tracker template.
