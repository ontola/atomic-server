{{#title Table change list - rows changed since a cursor}}
# Table change list

`GET /changes?table=<subject>&since=<cursor>&limit=<n>` answers one question:
which rows of this table changed since I last asked? Deleted rows are
included, as tombstones. Each row comes with its Loro version, so a client can
compute field-level differences against a copy it keeps itself.

It exists for two-way sync. A plugin that mirrors a table to another service
reacts to live changes for speed, and reads the change list for correctness:
it misses nothing across restarts, or while it was switched off.

## Tables and rows

A **table** is a resource whose `isA` includes
[`Table`](https://atomicdata.dev/classes/Table) and that has a
[`classtype`](https://atomicdata.dev/properties/classtype). A **row** of it is a
resource whose `parent` is the table and whose `isA` includes that classtype.
This is the same rule the data browser's table view uses. Other children of the
table, such as its views, are not rows.

| What happened to the row | Entry |
| --- | --- |
| Created in the table, moved into it, or given its class | `created` |
| Edited, and still in the table | `updated` |
| Destroyed, moved out, or lost its class | `deleted` |

Changes made on this node, commits from other clients, and resources that
arrive by sync from a peer all count.

## Request

| Parameter | |
| --- | --- |
| `table` | The table's subject. |
| `since` | A cursor from an earlier response. Leave it out to list every current row. |
| `limit` | Page size. Default 100, at most 500. |

Sign the request like any other authenticated read (see
[Authentication](authentication.md)). The caller must be able to read the
table. Each live row is also checked for read and left out if the caller can't
read it; the cursor still moves past it.

## Response

```json
{
  "changes": [
    {
      "subject": "https://example.com/tasks/42",
      "kind": "updated",
      "version": { "7359172904011432": 12, "942108773": 3 },
      "at": 1790000000000
    },
    {
      "subject": "https://example.com/tasks/43",
      "kind": "deleted",
      "version": { "7359172904011432": 4 },
      "at": 1790000000500
    }
  ],
  "cursor": "eyJ2IjoxLCJ0Ijoi…",
  "hasMore": false
}
```

- `version` is the row's Loro version vector after the change: peer id to
  counter, as `loro-crdt`'s `doc.version().toJSON()` gives it. For `deleted`,
  it is the last version the server held.
- `at` is when the server recorded the change, in milliseconds.
- Only the latest change per row is kept. A row created and then edited since
  your cursor reads as `updated`, so treat `created` and `updated` the same:
  upsert.
- When `hasMore` is true, ask again with `cursor` right away. When it is false,
  store `cursor` and use it next time.
- Without `since`, the answer also carries tombstones that are still retained.
  A client starting from nothing can ignore them.

## Errors

| Status | `error` | Meaning |
| --- | --- | --- |
| 410 | `CURSOR_EXPIRED` | The cursor is older than the tombstone retention, or the table's rows were redefined (its `classtype` changed). Resync: list without `since` and reconcile. |
| 400 | `INVALID_CURSOR` | Not a cursor this server issued for this table. |
| 400 | `NOT_A_TABLE` | The subject is not a table. |
| 401 / 404 | | The caller can't read the table, or it doesn't exist. No row is named. |

## Cursors and retention

The cursor is opaque. Store it as a string and don't parse it.

Tombstones are kept for 30 days by default. Set
`--table-change-retention-days` (or `ATOMIC_TABLE_CHANGE_RETENTION_DAYS`) to
change that. A client that is offline for longer gets `CURSOR_EXPIRED` and
resyncs. Rows that still exist are always listed, however old their last change
is.

## Tables older than the change list

The first request for a table that has no change list yet lists every current
row as `created`. After that, only real changes appear.

## Clients

`@tomic/lib`:

```ts
import { TableChangesCursorExpiredError } from '@tomic/lib';

let cursor = loadCursor();
try {
  let page;
  do {
    page = await store.getTableChanges(table, { since: cursor });
    for (const change of page.changes) apply(change);
    cursor = page.cursor;
  } while (page.hasMore);
  saveCursor(cursor);
} catch (e) {
  if (e instanceof TableChangesCursorExpiredError) resyncFromScratch();
  else throw e;
}
```

Rust: `atomic_lib::change_log::table_changes(&db, &table, since, limit, &for_agent)`.
