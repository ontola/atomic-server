# Unify resource representations (browser side)

> Status: planned 2026-05-28. Correctness. Invasive.
>
> **Parent plan:** [`loro-source-of-truth.md`](./loro-source-of-truth.md)
> already specifies the Rust/`Db`/Flutter version of this shift — making
> the Loro doc primary and `PropVals` derived. This doc is the
> browser-side dual: the same goal applied to `Resource._cache` in
> `browser/lib/src/resource.ts`. The two should land together (or at
> least share an RFC) since they're the same architectural decision
> seen from two embeddings.

## Problem

A "resource" exists in **three** materialised forms on the client at
the same time:

1. **`Resource._cache: Map<Property, Value>`** — the JSON-AD
   property bag. Mutated by `setSubject`/`set` calls and by commit
   replay.
2. **The Loro document** (`LoroLoader.docs.get(subject)`) — the
   authoritative collaborative state, with a `propval` map plus
   container nodes for rich content (TipTap body, canvas).
3. **The persisted OPFS snapshot** — what gets reloaded on boot.

These three representations are kept in sync via ad-hoc paths:

- A local edit updates `_cache` synchronously, then queues a commit
  that includes a Loro delta; on commit apply the Loro doc updates,
  and a "loro → propval mirror" callback writes back into `_cache`.
- An incoming UPDATE frame parses the JSON-AD into `_cache` and
  applies the Loro snapshot into the doc separately.
- The persistence layer writes the Loro snapshot; `_cache` is
  re-derived from the doc on rehydrate.

## Symptoms traced to this split

- **Canvas genesis-save bug**: `_cache` and the Loro doc disagreed on
  whether the resource existed, so a "save" emitted a Loro snapshot
  with `is_genesis: true` even though the server already had it.
- **TipTap body editing bug (this session)**: the causality guard
  rejected commits whose `propval_intent` was empty even though the
  Loro doc had real changes (body container edit). The cache and the
  doc had a legal divergence that the protocol didn't model.
- **Plugin install refresh bug**: `_cache` had stale `props.plugins`
  because the Loro mirror callback didn't fire under React Compiler
  memoization.

## Proposal

Make the Loro doc **authoritative**. `_cache` becomes a memoized,
invalidated read off the doc's `propval` map. Specifically:

```ts
class Resource {
  // No _cache field anymore.
  getProperty(p: Property): Value | undefined {
    return LoroLoader.docs.get(this.subject)
      ?.getMap('propval')
      .get(p);
  }
  // For non-Loro callers (legacy):
  getCacheLike(): Record<Property, Value> {
    return Object.fromEntries(/* doc.propval entries */);
  }
}
```

Updates:
- Local edits write into the doc directly; the doc subscription fires
  notify().
- Incoming UPDATE parses JSON-AD and writes into the doc's propval
  map (same path).
- OPFS persist writes the doc; rehydrate reads it. No separate
  `_cache` snapshot to persist.

## Why this is hard

- React Compiler memoization (see
  [react-compiler-resource-proxy.md](./react-compiler-resource-proxy.md))
  fights us: reads off `Resource.props.X` need to invalidate when the
  doc changes.
- Some properties currently in `_cache` aren't in the Loro doc (e.g.
  `last_commit`, server-supplied audit fields). Need to decide
  whether those go into the doc or live in a separate `meta` map.
- Migration: every screen reads `_cache` directly somewhere. Codemod
  required.

## Risk

- High. This is the most invasive item on the audit. Recommend an RFC
  before code.
- Performance: every read becomes a Loro doc map lookup. Profile.

## Effort

- 1 week design + RFC.
- 2 weeks implementation behind a feature flag.
- 1 week migration.

## Concrete steps

1. Write RFC: storage shape, what lives in propval vs. meta vs.
   audit, how subscribers learn about changes.
2. Prototype on a single resource type (Folder, low blast radius).
3. Measure perf delta on the documents:25 / canvas screen.
4. Decide go/no-go.
