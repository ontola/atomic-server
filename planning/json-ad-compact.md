# JSON-AD-Compact: one wire dialect for the LLM assistant

> Status: **Phase 1–2 shipped** (resolver, tool I/O, table/context providers).
> Remaining: rebase `create_table.rows` on `fromCompact`; server
> `format=compact`. First consumer: the data-browser AI assistant tools
> (`useAtomicTools.ts`). Related: [[SDK-API-design]] (agent DX),
> [`mcp-endpoint.md`](./mcp-endpoint.md) (Atomic as MCP server; phase 4 is
> its Rust path), the `create_table` spec vocabulary in
> `createTableFromSpec.ts`, and the drive-structure / custom-classes
> system-prompt inventories.

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
4. **Identity is never name-based — but it may be prefix-shortened.** Names
   address *schema* (stable, human-scale, class-scoped); letting the model
   reference arbitrary resources by title would make references
   rename-fragile. Tag names are the one carve-out: `allowsOnly` makes that
   namespace tiny and closed. Full DIDs, however, are ~35 tokens of noise the
   model only ever echoes back, so tool I/O shortens `did:ad:` subjects to
   derived refs: `#<first 8 DID chars>` (`helpers/subjectRefs.ts`). Derived,
   not allocated — no counter table to persist; a session registry (re-seeded
   every turn by the drive tree and every shorten call) expands them at the
   tool boundary and in markdown-link rendering. Unknown refs (e.g. from an
   older session) fail loudly with a "find it again" hint. Refs never reach
   storage.
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
| 1 | Resolver module + unit tests for pure resolution/coercion | **done** |
| 1 | Reads emit compact: `get_atomic_resource`, `query` results | **done** |
| 1 | Writes accept compact: `create_resource` (incl. batch), `edit_atomic_resource` property-by-shortname + tag-name values | **done** |
| 1 | `query` gains `class` param: shortname `where` keys, tag-name values, implied `isA` filter | **done** |
| 1 | System-prompt grammar section; slim per-tool JSON-AD explanations | **done** |
| 1 | Short subject refs (`#xxxxxxxx`) at the tool boundary + drive-tree/custom-classes seeding + markdown-link and tool-bubble expansion | **done** |
| 2 | Context items (`processAtomicResources`) emit compact; per-class context providers (table → row-class schema + tag map + first N rows + count in transient context) | **done** |
| 3 | `create_table.rows` / `rowToPropVals` re-based on `fromCompact` | remaining |
| 4 | Server-side `format=compact` so MCP server & other clients share it instead of reimplementing resolution | remaining; consumer: [`mcp-endpoint.md`](./mcp-endpoint.md) |

## Decisions record

- **Class-anchored scoping, no embedded context** — the schema *is* the
  context; documents stay self-contained-free on purpose.
- **Collision handling v1**: on read, colliding shortnames fall back to full
  URL keys (deterministic, lossless); qualified keys (`crm.status`) can come
  later if collisions prove common. On write, ambiguity is a hard error.
- **Refs are derived prefixes, not counters** — `#<8 DID chars>` is
  recomputable, debuggable (visibly the same identifier everywhere), and
  needs no per-conversation table persisted with the chat. Rejected: `r1`/
  `r2`-style allocation (state to persist, breaks on restore) and truncated
  `did:ad:…` forms (mistakable for real subjects and storable by accident).
- **Relations by subject/ref only** (v1). Title-based relation lookup
  rejected: mutable addressing.
- **Timestamps ISO on the wire**, ms in storage; date props pass through
  (`YYYY-MM-DD` already).
- **Not stored, ever.**
