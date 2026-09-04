# Local full-text search (KV inverted index)

Status: **Landed.** The engine lives in `atomic_lib::search` on redb / sled /
BTreeMap (OPFS and desktop share it). Hosted `atomic-server` `/search` is a
thin adapter over the same engine. The browser talks to it through
`ClientDb.search` and merges with `/search` when online (covers OPFS lag).

## Why

Dropping the embedded Actix server from Tauri (see
[`atomic-lib-runtime.md`](./atomic-lib-runtime.md)) also dropped mmap-Tantivy.
OPFS never had it. MiniSearch was an in-memory name/description/shortname
index rebuilt lazily — that JS path is gone. Local search is the product
path, not a fallback. Tantivy is gone from the server too: one engine
everywhere.

The bar is prefix typeahead + document text + persistence + 1-edit
prefix-fuzzy (`avacado` finds `avocado` and `avo` typeahead works), plus
exact `property:"value"` filters for the file picker and class selector.

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

Query: tokenize, AND tokens, BM25 with title exact 10 / prefix 6 / fuzzy 4,
description/body lower. Parent/drive scope walks `SearchDocs.parent` /
`drive`, falling back to the resource when it has no searchable text.

Filters: AND of exact property-value pairs, served from the existing
`PropValSub` index (same `{property}-{value}-{subject}` collections already
use). Empty `q` + filters lists those subjects (file picker `isA:File`,
class selector, ontology panel). The HTTP `filters=` string is exact
`property:"value"` pairs joined by ` AND `. No query language.

Fuzzy:

1. Always prefix-scan the original token (typeahead).
2. Tokens of length 2–12: generate the 1-edit neighborhood and prefix-scan
   each variant.
3. Longer tokens: trigram candidates, then
   `min_prefix_levenshtein(q, term) ≤ 1`.

Not in this engine: distance 2, stemming, phrase positions, Lucene query
language. Table `contains` still planned via this index.

## Upgrade

Opening a store that has resources but no search trees rebuilds the index
once (`PluginMeta` key `search_index_v1`). New writes index incrementally.
`Db::build_index` and `--rebuild-indexes search` also reindex FTS.

## Remaining

- Table `contains` through this engine (`planning/table-view-filters.md`).
- Flutter `AtomicNode::search` wiring in the bridge.
