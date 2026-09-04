# Local full-text search (KV inverted index)

Status: **Landing.** The first slice is in `atomic_lib::search` on redb / sled /
BTreeMap (so OPFS and desktop get the same engine). Hosted `atomic-server`
still serves Tantivy over `/search`; the browser prefers the local KV index
when `ClientDb` is ready and falls back to MiniSearch, then Tantivy.

## Why

Dropping the embedded Actix server from Tauri (see
[`atomic-lib-runtime.md`](./atomic-lib-runtime.md)) also drops mmap-Tantivy.
OPFS never had it. MiniSearch is in-memory, name/description/shortname only,
and rebuilt lazily. Local search is the product path, not a fallback.

The bar is MiniSearch query feel + Tantivy document text + persistence +
Tantivy's 1-edit prefix-fuzzy (`FuzzyTermQuery::new_prefix(term, 1, true)`),
so `avacado` finds `avocado` and `avo` typeahead works.

## Shape

```text
atomic_lib::search::query(db, q, SearchOpts) -> [SearchHit]
index_resource / unindex_subject on every apply_commit + add_resource_opts
```

Trees (names in `lib/src/db/trees.rs`):

| Tree | Key | Value |
| --- | --- | --- |
| `SearchPostings` | `field_id \|\| token \|\| 0x00 \|\| subject` | tf (u32 BE) |
| `SearchDocs` | subject | drive, parent, per-field token counts |
| `SearchDocTokens` | subject | tokens, so delete can drop postings |
| `SearchTrigrams` | `trigram \|\| 0x00 \|\| term` | empty (candidate generation) |

Fields: title (name / shortname / filename), description, Loro body
(`AtomicLoroDoc::extract_document_plain_text`). Commits are skipped.

Query: tokenize, AND tokens, BM25 with Tantivy-like boosts (title exact 10,
title prefix 6, title fuzzy 4, description/body lower). Parent/drive scope
walks `SearchDocs.parent` / `drive` (same semantics as MiniSearch + Tantivy
`parents=`).

Fuzzy:

1. Always prefix-scan the original token (typeahead).
2. Tokens of length 2–12: generate the 1-edit neighborhood and prefix-scan
   each variant.
3. Longer tokens: trigram candidates, then
   `min_prefix_levenshtein(q, term) ≤ 1`.

Not in v1: distance 2, stemming, phrase positions, Lucene query language,
JSON propval `property:"value"` as a first-class posting (filters currently
post-check loaded resources). Table `contains` still planned via this index.

## Upgrade

Opening a store that has resources but no search trees rebuilds the index
once (`PluginMeta` key `search_index_v1`). New writes index incrementally.
`Db::build_index` also reindexes FTS.

## Hosted server

Keep Tantivy as the HTTP `/search` adapter. Local nodes (OPFS, Flutter,
future Tauri-without-Actix) use this index. Vector search stays opt-in
LanceDB on the server.

## Remaining

- JSON propvals / `property:"value"` as indexed postings.
- Table `contains` through this engine (`planning/table-view-filters.md`).
- Flutter `AtomicNode::search` wiring in the bridge.
- Optionally retire MiniSearch once ClientDb is the only offline path.
