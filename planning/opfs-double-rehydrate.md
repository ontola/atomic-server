# OPFS double rehydrate on startup

> Status: fixed 2026-05-28 in `browser/lib/src/store.ts`. Performance / DX.

## Symptom

On a cold tab open against a populated drive, the local-search
rehydration path runs more than once during boot. For a drive with
hundreds of resources this both wastes CPU and produces duplicate
entries in the MiniSearch index (MiniSearch's `add()` doesn't dedupe).

Originally suspected as a "populateFromOpfs called from a route + the
worker init" duplication; on investigation the actual shape is
different (see below).

## Root cause (actual)

`browser/data-browser/src/helpers/initClientDb.ts` calls
`store.setClientDb(clientDb)` **three times** per page load:

1. Line 195 — eager (right after construction).
2. Line 208 — post-init success (re-emit sync status).
3. Line 214 — post-init error (re-emit sync status with the error).

Each call to `setClientDb` did three things:

1. Reassign `store.clientDb` (idempotent — same worker every time).
2. Re-emit sync status (the actual reason for calls 2 + 3).
3. Trigger `void this.rehydrateLocalSearch(clientDb)` (unintended).

`rehydrateLocalSearch` walks the entire OPFS-backed corpus and indexes
every entry into MiniSearch. Calls 2 and 3 hit `clientDb.waitForReady()`
immediately, so on a successful boot the index rebuild runs twice in
quick succession.

## Fix

Gate the rehydrate inside `setClientDb` on the worker reference
actually changing:

```ts
public setClientDb(clientDb: ClientDbWorker): void {
  const isNew = this.clientDb !== clientDb;
  this.clientDb = clientDb;
  this.emitSyncStatus();
  if (!isNew) return;
  void this.rehydrateLocalSearch(clientDb);
}
```

Single edit in `browser/lib/src/store.ts`. The three callers in
`initClientDb.ts` keep working — they still refresh sync status, just
no longer trigger a redundant index rebuild.

## Risk

Trivial. The change is semantically correct (reassigning the same
worker is a no-op for the index). If a future caller needs a forced
re-rehydrate after `setClientDb(sameWorker)`, expose an explicit
`forceRehydrateLocalSearch()` method then.

## Follow-ups

- Consider extracting the post-init sync-status emission to a named
  method (`notifyClientDbStateChanged`) so the calls at 208/214 read
  as intent-of-status rather than "re-attach the same worker".
- The 195→208/214 sequence is the kind of API misuse that
  [unify-resource-dirty-signals.md](./unify-resource-dirty-signals.md)
  could prevent — if "ready" / "errored" were just transitions on a
  single status, callers wouldn't need to thread the worker through to
  flip state.
