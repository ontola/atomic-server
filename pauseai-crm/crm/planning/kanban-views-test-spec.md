# Test spec: Kanban views + `create_table` API

> Manual/Charlotte verification for the kanban view work and the assistant
> `create_table` tool. Covers the ontology change, the renderer, drag-and-drop,
> the no-enum fallback, the view-kind picker, the table template, and the
> one-call table builder.

## Environment

- A running `atomic-server` (default `http://localhost:9883`) initialized with
  `ATOMIC_INITIALIZE=true`, its store carrying the new `view-group-by` ontology
  property (fresh init, or `ATOMIC_REPOPULATE_DEFAULTS=true`; a store opened by
  a build that embeds the property picks it up on its own since the bootstrap
  fingerprint landed).
- The data-browser served against it — either the Vite dev server (source, HMR)
  or the built bundle. Front-end must include this branch's changes.
- Signed-in agent with write access to a drive.

## Scenarios

### 1. Issue-tracker template (table-scoped picker)

1. Open the New Table dialog (drive `+` → Table, or the new-resource route).
2. **Expect:** a "Start from" picker with **Blank** and **Issue Tracker** cards;
   Blank selected by default.
3. Select **Issue Tracker**, set a name (e.g. "Issues"), Create.
4. **Expect:** navigates to the new table; a **kanban board** is the default
   view (a "Board" tab + an "All issues" tab); columns **Todo / Doing / Done**
   plus a **No status** column; the row class has Status, Assignee, Priority
   columns.
5. **Expect:** selecting "All issues" shows the same rows as a table grid.

### 2. Blank table still works

1. New Table → keep **Blank** → the "Use existing class" option is visible.
2. Create → an empty table with a Name column, default (table) view. No
   regression from before.

### 3. Kanban on an existing table with no enum (auto-create Status)

1. Open a plain table that has no select/enum property.
2. Add a view via the `+` tab → pick **Kanban**.
3. **Expect:** a `Status` property (Todo/Doing/Done) is created silently and
   adopted as the group-by; the board renders with those columns + No status;
   every existing row starts in **No status**.
4. **Expect:** the new `Status` column also appears in the table view.

### 4. Drag-and-drop moves a card between columns

1. On a kanban board, drag a card from **No status** onto **Doing**.
2. **Expect:** the card moves to Doing and stays after a reload; the row's
   status property is now the Doing tag (verify in the table view / resource).
3. Drag it back to **Todo** → moves and persists.

### 5. Adopting an existing enum property

1. On a table that already has a select property (e.g. from scenario 1's
   Priority), create a Kanban view.
2. **Expect:** it adopts an existing select property as group-by rather than
   creating a duplicate Status. (Group-by precedence: explicit `view-group-by`
   > existing select > auto-create.)

### 6. View-kind picker

1. `+` in the view tabs opens a dropdown with **Table** and **Kanban**.
2. Creating each makes a view of that kind, persisted on reload.

### 7. `create_table` assistant tool (one call)

Prompt the AI chat with something like: *"Create a table called Bugs with a
Status select (Open, In progress, Fixed), a Severity select (Low, High), and a
kanban board grouped by Status."*

1. **Expect:** the assistant calls **`create_table` once** (not many
   `create_resource` calls), and the response includes the table subject + a
   column→subject map.
2. **Expect:** navigating to the table shows the kanban board grouped by Status
   with the three columns; Severity exists as a column.
3. **Regression:** adding a row via the assistant (`create_resource`, parent =
   table subject) still works and the row appears on the board (in No status
   until a status is set).

## Pass criteria

- All scenarios behave as described; no console errors on the kanban route.
- No regression to the existing table grid, filters, or view tabs.
- `view-group-by` persists on the View resource across reloads.
