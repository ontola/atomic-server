# Atomic Data Tables

## Zero-discovery rule

If the table is already attached to this chat (an `<atomic-context>` block
with `Row schema:`, `Row class:` and a row sample), you have EVERYTHING needed
to add or edit rows. Do NOT read the table, its class, its properties, its
tags, or its rows again — go straight to ONE `create_resource` /
`edit_atomic_resource` call using the refs and shortnames from that block.

## Architecture Overview

A table setup consists of three interconnected parts:

A Table resource: The entry point for the user.
A Class resource: Defines the "schema" or columns of the table. Linked to the table via the table's `classtype` property.
The Properties: Individual fields used by the Class. These represent the columns of the table.

Reading a table with `get_atomic_resource` returns it in compact form; its
`classtype` is the row class. Reading is only needed when the table is NOT
already attached as context.

## Creating Tables

**Prefer the `create_table` tool.** It builds the whole table — the row Class,
every column, any saved views (table or kanban), AND the initial rows — in a
single call. Describe it declaratively:

```json
{
  "name": "Issues",
  "columns": [
    {
      "name": "Status",
      "type": "select",
      "options": ["Todo", "Doing", "Done"]
    },
    { "name": "Assignee", "type": "relation" }
  ],
  "views": [
    {
      "name": "Board",
      "kind": "kanban",
      "groupByColumn": "Status",
      "default": true
    }
  ],
  "rows": [{ "name": "Set up CI", "Status": "Todo" }]
}
```

A `name` title column is always added automatically — don't include it. Column
`type` is one of `text`, `markdown`, `number`, `date`, `datetime`, `checkbox`,
`relation`, `file`, `select` (`select` needs `options`).

Only fall back to building a table by hand (multiple `create_resource` calls)
when you need something `create_table` can't express. For that lower-level
recipe read `/creating-tables`.

## Editing The table structure

If you need to edit the structure of a table read `/creating-tables` to learn how tables are made. From there you can infer how that structure is modified.

## Adding and modifying rows

Rows are children of the table, instances of the table's `classtype`. Add
rows with ONE batched `create_resource` call — an array of compact objects:

```json
[
  {
    "@class": "<row class ref>",
    "@parent": "<table ref>",
    "name": "Acme Corp",
    "status": "Lead",
    "value": 50000
  },
  {
    "@class": "<row class ref>",
    "@parent": "<table ref>",
    "name": "TechNova",
    "status": "Qualified"
  }
]
```

- Keys are the row-class shortnames from the schema line; select values are
  tag names. Never call `create_resource` once per row.
- `createdAt` is added automatically when the parent is a table (rows only
  appear in the table once it is set; it drives the default sort order).
- Edit a single cell with `edit_atomic_resource` (shortname + tag name work).

To list rows use `query` with the row class:
`{"class": "<row class ref or shortname>", "where": [...]}` — filters accept
shortnames and tag names (e.g. `{"property": "status", "value": "Done"}`).
Keep in mind that a table might have a huge amount of rows, so it might not
always be preferable to load them all if you're looking for something.

## Gochas
