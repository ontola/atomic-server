# Tables

Tables are how you create and work with structured data in AtomicServer.
Each table is a folder of resources that share one [Class](../../schema/classes.md);
the class's properties become columns. Every cell is type-safe — a number column
cannot hold text.

![Table](../../assets/ui-guide/gui-tables-example.avif)

Under the hood a table is ordinary Atomic Data: rows are resources, columns are
properties, views are configuration resources. That is why the same table works
offline (the browser runs the same query engine through WASM), why an assistant
can build one for you, and why a "mini-app" is just a saved configuration rather
than a custom renderer.

## Creating a table

Click the **+** button in the sidebar or a folder and choose **Table**.

1. Pick a **template** (Issue Tracker, CRM, Expenses, Time tracker, …) or start
   from **Blank**.
2. Give the table a name. That name becomes both the table title and the name of
   the row class. Using a `name` column is recommended — it keeps resources
   findable by search and compatible with other tools.
3. Optionally **use an existing class** instead of creating a new one.

Classes and columns created by tables are added to the drive's default ontology.

## Views

A table can have many **views**. Each view is a different way of looking at the
same rows — filters, sort, column order, and renderer are all per-view.

| Kind | What it shows |
| --- | --- |
| **Table** | Classic grid. Editable cells, sortable columns, aggregates. |
| **Kanban** | Columns grouped by a select property. Drag cards between columns. |
| **Calendar** | Rows placed on a date or datetime property. |
| **Timer** | Start/stop controls against datetime columns, with a live duration. |

Create a view from the view switcher on the table page. Change a view's kind
from the view settings (table ↔ kanban ↔ calendar ↔ timer) without losing the
underlying data.

## Filters

Each view can AND together multiple `(property, operator, value)` filters.
Operators depend on the column datatype (equals, contains, greater/less than,
is empty, …). Filtered aggregates and totals describe the filtered set, not the
whole table.

Filters are live: when a row is edited so it no longer matches, it leaves the
view immediately (including offline, in the local store).

## Computed columns, totals, and actions

- **Computed (derived) columns** — values calculated from other columns, e.g.
  elapsed duration between two timestamps, days since a date, or quantity ×
  price. They are configuration, not a separate datatype, so they appear in any
  view that includes them.
- **Totals / aggregates** — sum, count, average, min, max over every matching
  row (not just the page on screen), with optional breakdowns by a column
  (exact value, day, or month). Computed by the store; identical online and
  offline.
- **Row actions** — one-tap buttons on a row that apply a closed set of patches
  (`setNow`, `setValue`, `toggle`, `increment`). Each press is an ordinary
  [Commit](../../commits/intro.md).
- **Quick-add** — a create button that stamps presets onto a new row in one
  press (for example: start a timer entry with the current time).

## Templates

The New Table dialog offers ready-made starting points. Examples:

- **Issue Tracker** — Status / Assignee / Priority with a kanban board
- **Project tasks** — board + calendar + estimated-hours total
- **Time tracker** — start/stop timer grouped by project
- **Expenses** — receipts, monthly sum, category breakdown
- **Deals (CRM)** — pipeline board, deal value, days since contact
- Plus grocery list, plant care, workout log, and more

Templates are data and configuration only (columns, views, computed columns,
totals). They do not ship a custom renderer — anything a template builds, you
can build by hand or ask the [Atomic Assistant](ai-and-atomic-assistant.md) to
build via `create_table` / `list_table_templates`.

## Localization

Columns with the [`LocalizedText`](../../schema/datatypes.md#localizedtext)
datatype store a map of language tag → string in one cell. The table editor
shows a language switcher and can split a LocalizedText property into one
column per language. See [Translations & Localization](../../schema/translations.md).

## Collaboration

Other people viewing the same table appear as colored cell rings on the cell
they have selected, and as avatars in the navbar. See
[Presence & collaboration](presence.md).

## Editing features

- **Rearrange columns** — drag column headers (order is saved per view,
  including computed and timer columns).
- **Resize columns** — drag the edges of the column header.
- **Sort rows** — click a column header.
- **Keyboard navigation** — arrow keys, Excel-like hotkeys.
- **Copy & paste** — multi-cell selection with `Ctrl/Cmd + C` / `V`. Pasting
  works across tables and apps that support HTML table data.
- **Export to CSV** — Export button in the top right.
- **Works offline** — create, edit, filter, and total rows with no server; sync
  when you reconnect. See [Local-first](../local-first.md).
