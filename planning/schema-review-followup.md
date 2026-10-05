# Schema review follow-up (2026-10-05)

Review target: draft #2045 at `c084fde1e078cc75ea125106d7b1116525df44c8`.
Pre-PR comparison: `81f5604848b3b4dc9dfd644f1fd43bee7288e90d`.

## Corrections

- Native genesis and signing attach definitions directly to the pending Loro
  document before assigning its message. Neither history reads nor snapshot
  export/import may happen during this attachment step. The regression test
  failed before the fix and now verifies creator attribution and two distinct
  signed edits for ordinary and frozen-schema resources.
- Native required-property checks reuse the resolved dependency closure. Ordinary
  documents inspect keys and class references without materializing unrelated
  data. Unreferenced attachments are still checked; a docless snapshot is decoded
  because it can contain attachments absent from the materialized properties.
- Browser validation uses selective reads and a single isolated reusable replica.
  Local edits refresh it, failed or abandoned candidates are discarded, and idle
  replicas are freed after five seconds. Tests cover ordinary-to-schema updates,
  malicious definitions, local history tokens and failed-candidate isolation.
- Sync errors name the rejected resource. A browser regression verifies that a
  valid entry after a rejected entry imports while completion remains blocked.
  Native bulk projection can reject its whole batch; it is not a per-entry
  partial-success API.

## Reproducible large-document probe

Run from `browser/lib`:

```sh
SCHEMA_IMPORT_BENCH=1 pnpm exec vitest run src/schema-import.perf.test.ts
```

The probe imports 35 small name deltas into 10,000 strokes with 640,000
coordinates (about 356 KB encoded snapshot). It discards five warmups and reports
30 samples. On this Mac, Node + Loro WASM:

| Version | Median | p95 |
| --- | ---: | ---: |
| Pre-PR Resource import | 14.49 ms | 15.94 ms |
| Reviewed draft c084fde | 197.42 ms | 285.87 ms |
| Selective reads, fresh fork per delta | 47.24 ms | 54.85 ms |
| Selective reads, reusable replica | 14.00 ms | 14.42 ms |

These are warm, repeated imports into one document, including the normal resource
rebuild. They do not measure browser rendering, first imports, alternating large
documents, Android, or live collaboration under load. The first import or an idle
refork still clones state. A single extra document remains a transient memory
cost. No timing threshold is enforced in CI.

## Review boundaries

Shared string/null semantics and stricter setters are intentional compatibility
changes, now documented explicitly. There is no peer enforcement negotiation yet;
all participating writers and readers must be upgraded for equivalent behavior.
Limits on the schema map do not bound CRDT decompression before validation.

Plugin mutable schemas and frozen app schemas remain separate. Choosing the
plugin contract requires coordination; this fix does not silently migrate
plugins or promise typed plugin RPC APIs. The existing draft is retained rather
than rewriting its review history into three stacked PRs. Protocol, representation
and SDK changes still need explicit review before merge. Exact-head CI, including
the downstream SaaS build, is required separately from the local evidence.
