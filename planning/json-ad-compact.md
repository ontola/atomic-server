# JSON-AD-Compact: one wire dialect for the LLM assistant

> Status: **In progress** (started 2026-07-08). First consumer: the data-browser
> AI assistant tools (`useAtomicTools.ts`). Related: [[SDK-API-design]] (agent
> DX), the `create_table` spec vocabulary in `createTableFromSpec.ts` (the
> shipped prototype of this idea), and the drive-structure / custom-classes
> system-prompt inventories that provide the ambient name→subject map.

## Problem

The assistant currently speaks ~5 dialects: raw JSON-AD with DID keys
(`create_resource`, `get_atomic_resource`), the compact spec vocabulary
(`create_table`), subject-keyed `where` clauses (`query`), prose + snippets
(`semantic_search`), and an indented text tree (drive structure). Costs:

- **Tokens.** A `did:ad:` subject is ~90 chars of high-entropy base64 —
  ~30–40 tokens — and appears as *every key and every reference* in raw
  JSON-AD. A single row read costs hundreds of tokens for ~20 tokens of
  information. Speculative payloads (context snapshots) are unaffordable.
- **Reliability.** Models copy long random strings imperfectly; one corrupted
  DID char = failed call + retry loop. Shortnames are 1–3 tokens and nearly
  impossible to mistype.
- **No transfer.** Each dialect needs its own prompt explanation, and the
  model can't reuse what it reads in one tool when writing through another.

## The format

Flat like JSON-AD. `@`-prefixed keys are structural (safe: shortname slugs
can't contain `@`); every other key is a property shortname.

```json
{
  "@id": "did:ad:xxx…",
  "@class": "deal",
  "@parent": "did:ad:yyy…",
  "name": "Acme Corp",
  "status": "Lead",
  "value": 50000,
  "closes": "2026-09-01"
}
```

### Rules

1. **`@class` is the context.** Shortname keys resolve against the class's
   declared properties (`requires` + `recommends`), then common core props.
   Unlike JSON-LD there is no embedded `@context` — the context already lives
   in the database as the class schema, so nothing is shipped and nothing
   drifts. Locally scoped by design.
2. **Full URLs stay legal as keys everywhere** (escape hatch, and how raw
   JSON-AD remains accepted). A key that parses as a URL bypasses resolution.
3. **Values follow the property datatype.** Dates/timestamps as ISO strings
   (coerced to ms on write); select/tag values by tag shortname (coerced to
   tag subjects, single value wrapped into the required array); relations by
   `@id`; arrays native.
4. **Identity is never compact.** `@id` is always a full DID. Names address
   *schema* (stable, human-scale, class-scoped); DIDs address *data*. Letting
   the model reference arbitrary resources by name would make references
   rename-fragile. Tag names are the one carve-out: `allowsOnly` makes that
   namespace tiny and closed.
5. **Reads are forgiving, writes are strict.** Emitting compact is always
   safe (subject→shortname is unambiguous; collisions emit the full URL key).
   Accepting compact must never misresolve silently: unknown or ambiguous
   keys are hard errors listing the candidates, and every write response
   echoes the resolved shortname→subject map so misresolution is visible in
   the transcript.
6. **Wire format only — never stored.** Shortnames are mutable; persisted
   compact would corrupt on rename. JSON-AD remains storage truth; compact is
   resolved at call time.

### Why consistency is the point (not compression)

If reads emit compact and writes accept the same compact, every tool result
the model sees is a few-shot demonstration of the syntax it should write
next. The format teaches itself; compression falls out.

## Architecture

One module owns the dialect: `data-browser/src/chunks/AI/jsonAdCompact.ts`.

- `buildClassContext(store, classSubjects)` → cached resolution table:
  `shortname → {subject, datatype, classtype, tags}` + reverse map. Also
  matches property *titles* (display names), so `create_table`'s
  column-display-name dialect (`rowToPropVals`) converges here later.
- `toCompact(store, resource)` → compact object (used by every read surface).
- `fromCompact(store, obj)` → `{parent, isA, propVals, resolved}` (used by
  every write surface); throws listing candidates on ambiguity.

Hard rule: no tool, context provider, or prompt section hand-rolls its own
serialization. Consistency is enforced by imports, not discipline.

The grammar is stated **once** in the system prompt (short "Compact JSON-AD"
section); tool descriptions just say "compact form".

## Rollout

| Phase | Surface | Status |
| ----- | ------- | ------ |
| 1 | Resolver module + unit tests for pure resolution/coercion | **this round** |
| 1 | Reads emit compact: `get_atomic_resource`, `query` results | **this round** |
| 1 | Writes accept compact: `create_resource` (incl. batch), `edit_atomic_resource` property-by-shortname + tag-name values | **this round** |
| 1 | `query` gains `class` param: shortname `where` keys, tag-name values, implied `isA` filter | **this round** |
| 1 | System-prompt grammar section; slim per-tool JSON-AD explanations | **this round** |
| 2 | Context items (`processAtomicResources`) emit compact; per-class context providers (table → row-class schema + tag map + first N rows + count in transient context) | next |
| 3 | `create_table.rows` / `rowToPropVals` re-based on `fromCompact` | next |
| 4 | Server-side `format=compact` so MCP server & other clients share it instead of reimplementing resolution | later |

## Decisions record

- **Class-anchored scoping, no embedded context** — the schema *is* the
  context; documents stay self-contained-free on purpose.
- **Collision handling v1**: on read, colliding shortnames fall back to full
  URL keys (deterministic, lossless); qualified keys (`crm.status`) can come
  later if collisions prove common. On write, ambiguity is a hard error.
- **`@id` never compacted; relations by subject only** (v1). Title-based
  relation lookup rejected for now: mutable addressing.
- **Timestamps ISO on the wire**, ms in storage; date props pass through
  (`YYYY-MM-DD` already).
- **Not stored, ever.**
