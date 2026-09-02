# Outbox drain can silently drop a write (data loss)

> Status: **root-caused and fixed**, 2026-07-08. Three fixes landed together:
> the `LocalOutbox.drain()` re-entrancy fix, the debounce-window
> sync-status fix, and the reload-stranded cold-drain fix. Two
> related-but-separate issues remain open (see bottom).
>
> Found while writing `browser/e2e/tests/forms.spec.ts` (Forms builder
> Phase 2). Reproduced independently of Forms and of React — this was a
> `@tomic/lib` core save/sync issue. Related to, but distinct from,
> [`unify-resource-dirty-signals.md`](./unify-resource-dirty-signals.md).

## Problem (as observed)

A `resource.set(prop, value)` followed by `await resource.save()` could
report `'persisted'` (success), with the local in-memory value correct —
but a fresh server-side fetch sometimes still returned the **old** value.
No error, no blocked-outbox entry, `pendingDirtyCount` drained to `0`.
Non-deterministic: same code on the same resource could persist fine.

## Root cause 1 (confirmed): `drain()` shared-promise semantics

`LocalOutbox.drain()` shared a single in-flight promise: a `drain()`
call arriving while a pass was already running just returned that pass's
promise. But `doDrain` iterates a **snapshot of the entries taken when
the pass started** — subjects marked dirty after the snapshot are
invisible to it.

The losing sequence:

1. A drain pass is in flight (triggered by an earlier save on a sibling
   resource, or the macrotask-debounced auto-drain).
2. Test/user edits subject S (`set`) and calls `save()`, which does
   `outbox.markDirty(S)` then `await store.syncDirtyResources()` →
   `outbox.drain()` → **returns the in-flight promise**, whose snapshot
   predates S.
3. The in-flight pass finishes without ever visiting S. `save()`
   resolves `'persisted'` — but S was never POSTed.
4. An immediate server-side fetch sees the old value. The still-armed
   auto-drain posts S moments later — the loss was "save() lied about
   when", which under an immediate reload/fetch becomes real data loss.

The same shape occurs when S **is** in the snapshot but a new edit (V2)
lands while S's V1 POST is mid-flight: the drain correctly re-marks S
dirty (`caughtUp === false`), but the awaited pass has already moved
past S, so the late caller's `save()` again resolves early.

The originally suspected variant (drain clearing the dirty bit
unconditionally after a stale export) was **not** present — the drain
already captures `{bytes, versionAfterExport}` atomically, advances the
cursor to the exported version only, and re-marks dirty when ops landed
mid-POST. The bug was purely in the shared-promise semantics of
`drain()`.

### Fix 1

`browser/lib/src/local-outbox.ts` — `drain()` no longer merely shares
the in-flight promise. A call that arrives mid-pass chains **one
follow-up pass** (fresh snapshot) behind the current one and returns a
promise that resolves after that follow-up. The queued-flag resets when
the follow-up *starts*, so a call arriving during the follow-up chains
the next one. Invariant restored: `await drain()` means "every entry
dirty at call time has been attempted".

Regression tests: `local-outbox.test.ts` →
`LocalOutbox drain re-entrancy (planning/outbox-drain-data-loss-race.md)`
(3 tests; 2 of them fail against the pre-fix `drain()`).

## Root cause 2 (confirmed): debounce window invisible to sync status

Even with the drain fixed, `getSyncStatus().pendingDirtyCount === 0`
could be sampled during `useValue`'s 100 ms commit debounce
(`browser/react/src/hooks.ts` `saveResource`, and the same shape in
`useDebouncedSave`): the value is visible in memory, nothing is dirty in
the outbox yet, and `save()` is still parked in a React timer. A caller
(or e2e `waitForSync`) that then reloads loses the write. This is what
made the Publish step in `forms.spec.ts` flake after Fix 1 (the radio
options DID persist once the drain was fixed).

### Fix 2

`Store` now tracks a `_scheduledSaves` counter
(`startScheduledSave()` / `finishScheduledSave()`), included in both
`pendingDirtyCount` and `syncInProgress`. Both react debounce paths
(`useValue.saveResource` in `hooks.ts`, `useDebouncedSave` in
`useDebounce.ts`) increment when arming a fresh timer and decrement in a
`finally` after the scheduled `save()` settles — so the counter overlaps
the outbox/`isSaving` window with no gap. Set()-time dirty marking was
considered and rejected (changes commit granularity and genesis
ordering).

Regression test: `store.test.ts` → "counts scheduled (debounce-pending)
saves in sync status".

## Root cause 3 (confirmed): reload-stranded outbox entries never drain

The outbox persists pending entries to localStorage (per agent). After a
full page load, the fresh `LocalOutbox` hydrates them — but
`drainOutboxSubject`'s cold-drain branch (`!this.resources.get(subject)`)
returned **silently**, relying on "the hydration path will re-trigger the
drain once the resource is in place". If nothing on the current page ever
loads that subject, that never happens: the entry (and the write it
represents) is stranded forever, `pendingDirtyCount` stays > 0, the drain
spins silently (`failures: 0`, no error), and the edit never reaches the
server.

Observed in `forms.spec.ts`: navigating Form → Table → Form (full page
loads via `openSubject`) with 9 column-Property subjects freshly dirty at
navigation time. Post-reload, the FormPage never loads those Property
resources, so all 9 entries stranded and `waitForSync` hung.

### Fix 3

`drainOutboxSubject`'s cold branch now loads the resource itself via
`store.getResource` (OPFS-first, then server) and drains on top of that
state — but only once clientDb `isReady` (the OPFS snapshot is where
offline edits live; loading server state before that would export an
empty delta and silently drop them). Load failures throw into the
outbox's normal failure/backoff machinery instead of spinning silently.

Regression test: `store.test.ts` → "cold-drains outbox entries for
subjects no longer in memory".

### Follow-up worth investigating (not fixed)

Something bulk-marks all mapped column Property resources dirty right
around the Table-page visit / Form re-open (9 subjects within ~4 ms) —
write-on-render churn. Harmless now that stranded entries drain, but the
unnecessary writes widen every navigation race and deserve their own
look (likely FormPage's Property↔Field sync or TablePage column
materialization writing without a real change).

## End-to-end signal

`browser/e2e/tests/forms.spec.ts`'s strict persist-across-reload
assertions are the end-to-end signal — per explicit product decision
(2026-07-08) they were kept strict rather than softened. If that spec
goes flaky again, suspect a regression here first.

## Remaining, separate issue: property validation hits production, not the connected server

`Resource.set()`'s validation fetch for a brand-new, not-yet-upstreamed
default-ontology property (e.g. anything in a freshly added
`lib/defaults/*.json` like `forms.properties.formFieldOptions`) resolves
against the literal `https://atomicdata.dev/...` URL — production —
instead of the currently-connected local/self-hosted server. Any newly
added built-in Property fails this validation fetch in every environment
until it's deployed to production. Not data loss (`set()`
catch-and-warns and the edit still lands in Loro), but it adds latency,
console noise, and widens race windows. Needs its own look at how
`store.getProperty()` decides where to fetch an absolute-URL subject
from.
