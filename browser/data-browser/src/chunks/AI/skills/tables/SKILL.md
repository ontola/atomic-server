# Atomic Data Tables

## Architecture Overview

A table setup consists of three interconnected parts:

A Table resource: The entry point for the user.
A Class resource: Defines the "schema" or columns of the table. Linked to the table via the table's `classtype` property.
The Properties: Individual fields used by the Class. These represent the columns of the table.

Example JSON-AD Structure (Table):

```json-ad
{
  "https://atomicdata.dev/properties/isA": ["https://atomicdata.dev/classes/Table"],
  "https://atomicdata.dev/properties/name": "My Table",
  "https://atomicdata.dev/properties/classtype": "<SUBJECT_OF_THE_ROW_CLASS>",
  "https://atomicdata.dev/properties/parent": "<SUBJECT_OF_PARENT_FOLDER>"
}
```

## Creating Tables

**Prefer the `create_table` tool.** It builds the whole table — the row Class,
every column, and any saved views (table or kanban) — in a single call, and
returns the table subject plus a `column name → property subject` map. This is
far cheaper than creating the Class, Properties and Table one resource at a
time. Describe the columns declaratively:

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
  ]
}
```

A `name` title column is always added automatically — don't include it. Column
`type` is one of `text`, `markdown`, `number`, `date`, `datetime`, `checkbox`,
`relation`, `file`, `select` (`select` needs `options`). To add rows afterwards,
use `create_resource` with `parent` = the returned table subject.

Only fall back to building a table by hand (multiple `create_resource` calls)
when you need something `create_table` can't express. For that lower-level
recipe read `/creating-tables`.

## Editing The table structure

If you need to edit the structure of a table read `/creating-tables` to learn how tables are made. From there you can infer how that structure is modified.

## Modifying table rows

The rows in a table are just resources that are children of the table resource.
They are instances of the table's `classtype`.
They should have always have a [createdAt](https://atomicdata.dev/properties/createdAt) property, they won't appear in the table until this property is set.
The default table sort order is based on the `createdAt` property.

Example JSON-AD Structure (Row):

```json-ad
{
  "https://atomicdata.dev/properties/isA": ["<SUBJECT_OF_THE_ROW_CLASS>"],
  "https://atomicdata.dev/properties/parent": "<SUBJECT_OF_THE_TABLE_RESOURCE>",
  "https://atomicdata.dev/properties/createdAt": <UNIX_TIMESTAMP>,
  ...any other properties of the row class...
}
```

If you need every row in a table you can use the `query` tool with a where parameter of `{"https://atomicdata.dev/properties/parent": "<SUBJECT_OF_THE_TABLE_RESOURCE>"}`.
Keep in mind that a table might have a huge amount of rows, so it might not always be preferable to load them all if you're looking for something.

## Gochas
