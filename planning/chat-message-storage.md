# Storage per chat message

> **Status:** Partial (2026-10-05). Steps 1 to 5 are done; 6 to 8 are open.

A chat message with the text "hallo" took about 10.7 KB in the server store.
Measured with the ignored test `measure_chat_message_bytes`
(`lib/src/db/test.rs`): 50 messages in one chat, bytes per tree, with the
compressed trees counted as stored. Run it with
`cargo test -p atomic_lib --features db-redb --lib -- measure_chat_message_bytes --ignored --nocapture`.

The same signed data was kept four times (stored resource, genesis commit row,
envelope, Loro snapshot) and the two atom indexes wrote ten rows each.

| per message | start | now |
| --- | --- | --- |
| resources (message row + genesis commit row) | 2.7 KB | 1.7 KB |
| Loro snapshot | 1.5 KB | 0.3 KB |
| envelope | 2.4 KB | 0 |
| `PropValSub` | 1.9 KB | 0.7 KB |
| `ValPropSub` | 1.9 KB | 0.4 KB |
| search | 0.3 KB | 0.3 KB |
| **total** | **10.7 KB** | **3.5 KB** |

## Done

1. **Compress** resources, snapshots and envelopes (`db/compressed_kv.rs`). A
   marker byte keeps old rows readable.
2. **One copy of the genesis commit.** Its envelope is not written; the
   `Tree::Resources` commit row is the durable record and `envelopes()` rebuilds
   the envelope from it (`envelopes.rs`). Under `All` retention the first later
   commit writes it out.
3. **A creation's commit atoms are not indexed.** The commit is found by its id.
   Rights, parent and destroy commits are still indexed by subject.
4. **`ValPropSub` only holds references.** It answers "what points at X". Text,
   numbers and timestamps (`is_reference`) have no row. A value-only query
   (`value` without `property`) on a text value no longer finds new resources;
   nothing in the app issues one.
5. **The snapshot is a delta on the genesis commit.** The commit row already
   keeps the signed `loroUpdate`; the snapshot keeps only what came after it
   (`db/compressed_kv.rs`, codec 2) and a read puts the two back together. Whole
   snapshot when the commit row is missing (arrived by sync) or the rebuild
   does not match.

Old rows are left as they are; they go when their resource changes.

## Open

6. **Shorter index keys (about 0.3 KB).** The `https://atomicdata.dev/properties/`
   prefix as one byte, and the subject as 64 raw bytes (last field, so a `0xff`
   inside it cannot break the split). Needs both key forms deleted on removal,
   as for the legacy sort part, and the indexes rebuilt on upgrade.
7. **What is left is the signed Loro update** (commit row, about 1.1 KB) **and
   the message row** (0.4 KB). Every property key is a full URL inside
   the document, and a `datatypes` entry sits beside it. Short keys inside the
   document would cut each copy by roughly a quarter, but that changes what
   clients sign and send, so it needs a protocol version, not a migration.
8. **Search** (`SearchDocs` keeps the tokens a delete needs): 0.2 KB, could be
   recomputed from the resource on delete instead.

The snapshot cannot be dropped for a resource nobody has edited: it also holds
the changes the server writes (`lastCommit`, derived `drive`), which exist
nowhere else; the delta keeps just those.

## Property dictionary (design, 2026-10-05)

Per-row breakdown of one "hallo" message (3195 B): message row 439, genesis
commit row 1163, snapshot delta 347, `PropValSub`/`ValPropSub` about 1100,
search 148. Full property URLs and the 93 B subject repeat in nearly every row.

Two layers, the safe one first.

1. **Database dictionary (no protocol change).** A small tree maps each
   property URL and datatype tag to a 1 to 2 byte id, with an in-memory cache.
   Used by index keys, resource rows and the snapshot delta. A marker byte keeps
   old rows readable, as with compression. Open question: deflate on a 350 B row
   learns little, so a static substitution codec for well-known URLs before
   deflate may beat a learned dictionary for values; index keys need the id map
   either way.
2. **Short keys in the protocol (HDT-like).** The Loro document and the signed
   commit use ids from a fixed, published dictionary of well-known properties;
   custom properties keep their URL. Changes what clients sign, so it needs a
   protocol version and the old form keeps working.

Layer 1 first: measure per tree, build in its own PR. Layer 2 needs Joep's go on
the versioning approach before code.

## Short property keys in the signed document: measured (2026-10-09)

Joep approved a protocol version for short property keys. Before building,
measured on the real rows of one "hallo" message (genesis commit row 1837 B raw,
1067 B deflated; message row 540 B raw, 350 B deflated):

| Change to the commit row | Deflated | Gain |
| --- | --- | --- |
| Replace `https://atomicdata.dev/properties/` and `/classes/` by one byte | 1032 B | 35 B (3%) |
| Drop one copy of the signature text (subject is derived from it) | 991 B | 76 B (7%) |
| Store `loroUpdate` as msgpack `bin`, not an int array | about 0 after deflate | on raw rows only |

Deflate already folds the repeated URLs, so a fixed dictionary of short keys
inside the Loro document saves about 35 B of 3.3 KB per message, and it costs a
protocol version, a second signing form and a dictionary that must never change.
**Recommendation: do not build it.**

What is left in the commit row is mostly incompressible identifiers written as
base64 text: the subject/signature (87 B, twice), the agent id (57 B), the parent
subject (88 B, twice, once in `properties` and once in the update) and the Loro
peer id. The real floor is raw bytes for these, which are protocol-neutral
storage changes:

1. Do not store the signature twice (subject is derived from it): about 75 B.
2. Store ids as raw bytes in the row (base64 to 32/64 B): about 25% of the id bytes.
3. Chat log / frozen resource (31 to 44 B per message, measured earlier) remains
   the only change that is an order of magnitude, and does not touch the signed
   document format.

## On disk, not just in rows (2026-10-09)

`measure_chat_message_bytes` counts key and value bytes. The redb file grows
about twice that: 2000 messages, `redb::DatabaseStats` on the file.

| per message | bytes |
| --- | --- |
| keys and values (`stored_bytes`) | 3.3 KB |
| branch keys (`metadata_bytes`) | 0.3 KB |
| slack in half-full pages (`fragmented_bytes`) | 1.7 to 2.6 KB |
| free pages not yet reused | 0.5 to 1.6 KB |
| **file growth** | **6 to 7.4 KB** |

A redb B-tree page holds 4 KB and splits in half, so pages sit 50 to 65% full
(a plain redb test: 150 B index rows cost 250 to 350 B allocated, 1.4 KB values
2.9 KB). Sequential keys are worse than random ones, so key order is no fix.
Every byte cut from a row saves about two on disk, and fewer, larger rows save
more than shorter ones.

Where the 3.3 KB sits now: genesis commit row 1.2 KB, message row 0.45 KB,
snapshot delta 0.35 KB, `PropValSub` 0.6 KB (4 rows), `ValPropSub` 0.33 KB
(2 rows), search 0.32 KB. Each index row is about 160 B, of which 93 B is the
subject.

### Ranked options

| step | data | disk | format change |
| --- | --- | --- | --- |
| A. Subject ids: a subject dictionary (subject to a 4 to 8 byte id) used in index keys and search postings | -0.7 KB | about -1.3 KB | storage only, migration as in #2117 |
| B. One record per created resource: `lastCommit` of a genesis-only resource is derived from its subject (same signature), so no snapshot delta; the message row is materialized from the commit row on read | -0.8 KB | about -1.4 KB | storage only |
| C. Index less: no `PropValSub` row for text values (full-text search covers them) | -0.15 KB | about -0.3 KB | none |
| D. Chat log: messages are entries in one Loro document per chat, stored in chunks | to about 0.1 KB | to about 0.2 KB | model change |

A to C together: from about 3.3 KB data and 6.5 KB disk to about 1.6 KB and
3 KB per message. D is the only order of magnitude, but a message then is no
longer a resource of its own (no own URL, rights or commits; edits and
reactions live in the chat document).
