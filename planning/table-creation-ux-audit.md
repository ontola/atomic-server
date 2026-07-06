# Table creation UX audit

> Status: observation log from a live run on `http://localhost:6747/app/dev-drive`
> on 2026-07-03. No implementation decisions yet.

## 2026-07-03 UX pass

Addressed in the first focused pass:

- New property/column dialogs can opt into dialog-level autofocus, and the table
  add-column dialog opts into focusing/selecting the name field.
- New columns now start with a neutral `column` name instead of the selected
  datatype name (`text`, `number`, etc.), reducing accidental merged names like
  `texNotes`.
- Table cells now expose an accessible label with the property shortname and row
  number.
- Column header sort buttons now expose `Sort by <column>`.
- Protected column menus now show `Edit unavailable` instead of a disabled
  `Edit` item with no explanation.

Still open:

- Create-to-edit focus after creating a table still favors the title, not the
  first cell.
- Broader keyboard navigation checks for Tab / Shift+Tab / arrows / Escape are
  still needed.

## Flow tested

- Opened a fresh dev drive.
- Created a table from the main-content table icon.
- Named it `UX audit table`.
- Entered data into the first `name` cell.
- Added a text column.
- Opened column and filter controls.

## What works well

- The table create modal focuses the name input and preselects the default
  `Table` value.
- Pressing Enter from the table name input creates the table.
- After clicking the first empty cell, it becomes a real text input.
- Pressing Enter after typing a cell value saves the value and advances to a
  fresh row. This is a good spreadsheet-like default.
- The add-column menu exposes the important datatype choices directly: text,
  number, date, checkbox, select, file, JSON, relation, and external property.
- The filter chip flow focuses the filter value input after choosing a
  property, which makes simple filtering reasonably quick.

## UX issues to improve

- **Create-to-edit focus is inconsistent.** Table creation opens the new table
  and selects the title text. That is useful for renaming, but after the user
  just named the table it competes with the likely next action: filling the
  first row. Consider focusing the first editable cell after create, or making
  this dependent on whether the user accepted the default name.
- **Icon-only create buttons need accessible names immediately.** On the first
  page snapshot after load, the document/table/folder/chat buttons appeared as
  empty buttons to automation. A later snapshot had labels such as `New Table`.
  If this reflects hydration timing, screen reader and keyboard users may see
  unlabeled controls during the first interaction window.
- **The blank row cell has no accessible label.** The first data cell is exposed
  as an unlabeled text input. It should carry at least the column name and row
  number, e.g. `name, row 1`.
- **Column header buttons are partly unlabeled.** The visible `name` and
  `texNotes` header labels were exposed as buttons with an empty label in the
  table header. The adjacent menus are labeled (`Edit column`, `Add column`),
  but the primary header button should announce the column name and action.
- **Add-column modal focuses the close button.** After choosing `Add column` →
  `Text`, focus lands on the close button instead of the column name input.
  This makes keyboard-only column creation slower than table creation.
- **New text column naming produced `texNotes`.** Repro: choose `Add column` →
  `Text`, enter `Notes` in the `New Column` input with the default value present,
  then press Enter. The resulting header was `texNotes`, suggesting the default
  `text` value was only partially replaced or the caret started inside the
  default value.
- **Default column edit affordance is unclear.** Opening the `name` column menu
  shows `Edit` disabled. That may be correct for a protected default property,
  but the menu gives no reason. A disabled explanation or hiding unavailable
  actions would reduce ambiguity.
- **Filter entry starts terse.** The filter button first opens a column picker
  with only column names (`name`, `texnotes`). After choosing a property, the
  operator/value UI is clear. Consider a slightly more explicit first state such
  as `Filter by...` or a menu title, especially for first-time table users.

## Keyboard notes

- Verified:
  - Enter in the table create name field creates the table.
  - Enter in a focused text cell saves the value and moves to the next row.
  - Enter in the new-column name field creates the column.
- Not verified in this pass:
  - Tab / Shift+Tab traversal through cells and toolbar controls.
  - Arrow-key cell navigation.
  - Escape behavior for cell edit, add-column menu, filter menu, and modals.
  - Shortcut discoverability beyond visible labels like search `meta+k` and
    sidebar `\`.

## Follow-up candidates

- Add focused keyboard tests for table navigation: Enter, Tab, Shift+Tab,
  arrows, Escape.
- Add accessibility assertions for create buttons, table cells, and column
  header buttons.
- Reproduce the `texNotes` column-name bug in a component or e2e test before
  changing the column creation code.

## 2026-07-03 Esc focus follow-up

- The two-Escape bug was traced to popover-backed table editors: native
  `popover="auto"` can consume the first Escape to close the top-layer popover
  before the table sees the key.
- The old close path then focused the active cell wrapper, leaving the table in
  a visual-looking but unreliable keyboard state.
- Current fix direction: table context owns a shared `exitEditMode()` command;
  popover editor close paths call it, and table-level document key handling
  routes arrows while visual mode still owns a selected cell.
