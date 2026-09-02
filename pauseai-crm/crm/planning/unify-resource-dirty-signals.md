# Unify resource "dirty" signals

> Status: planned 2026-05-28. Correctness.
>
> This is one slice of [`unified-data-layer.md`](./unified-data-layer.md)
> (the "one outbox + saveState" part of the proposed redesign). It can
> ship in isolation as a self-contained step toward that bigger plan —
> the resulting `SaveState` API is the public surface the broader plan
> assumes.

## Problem

A resource on the client can be in one of several "in-flight" states
that are tracked in **three different places**:

1. **Outbox** (`local-outbox.ts`) — has an entry for this subject if a
   commit is queued / retrying / stuck.
2. **`Resource._loading`** — true while a network GET is in flight.
3. **`Resource._error`** — last GET / commit error message.

Plus implicit state in:
4. **Loro snapshot present** vs **absent** in `LoroLoader.docs.get(s)`.
5. **`store._fetching`** map — subjects currently being fetched.

UI components want to display "saving…", "save failed", "loading…",
"offline (queued)" — they have to look in different places, miss
states, and fall over when two states overlap (e.g., loading *and*
queued commit).

## Symptom

- The "saving" indicator on the document toolbar lags behind the
  outbox by ~1 render because it watches `_loading` not the outbox.
- The error toast for a stuck genesis commit fires from the outbox
  drain loop, separately from `Resource._error`, and the resource
  body still renders as if nothing is wrong.
- `useResource` consumers don't know to re-render when the outbox
  drops a stuck commit.

## Proposal

Single source of truth, derived:

```ts
type SaveState =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'saving'; attempts: number }
  | { kind: 'queued'; reason: 'offline' | 'retry' }
  | { kind: 'error'; message: string; recoverable: boolean };

store.getSaveState(subject: string): SaveState;
store.subscribeSaveState(subject, cb): Unsubscribe;
```

Implementation: a small reducer fed by outbox events + Resource
mutations + store fetch start/end. The hook layer exposes
`useSaveState(subject)`, components stop reading `_loading` / `_error`
directly.

## Why this is hard

- Touches every screen that shows a saving indicator (Document
  toolbar, Sidebar items, Resource page).
- Requires deciding which existing fields become *derived* vs.
  retained. Recommended: keep `_loading` (network in-flight) as a
  raw input, derive `SaveState` from it; deprecate ad-hoc reads.

## Risk

- Medium. Wrong derivation could make the indicator stick on
  "saving…" forever. Mitigate with property-based tests that drive a
  resource through every transition.

## Effort

- 1 day for the reducer + hook.
- 1 day to migrate consumers.

## Concrete steps

1. Inventory current consumers: `rg 'resource.loading\|resource.error'
   browser/data-browser/src`.
2. Design the state machine (transitions table).
3. Implement `getSaveState`/`subscribeSaveState` alongside the
   existing fields (no breakage).
4. Migrate one screen (Document toolbar) as a canary.
5. Migrate the rest, delete direct reads.
