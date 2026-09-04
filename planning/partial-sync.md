# Partial sync: replicating part of a drive

> **Status:** Proposal (2026-07-31). Nothing built. Records the design before
> the reconciliation redesign commits to a keyspace, because the choice made in
> [`drive-reconciliation.md`](./drive-reconciliation.md) Phase 2 decides whether
> partial replicas can ever use the fast path. Assumes — but does not require —
> the zone model in [`zones.md`](./zones.md). Related: F1 and the two-sync-layer
> split in [`unified-sync.md`](./unified-sync.md).

## The problem

Sync is all-or-nothing per drive. Every device that syncs a drive ends up with
every resource in it, and the protocol has no way to say otherwise — because
**absence is overloaded**. "I have no version vector for X" means exactly one
thing today: *send me X*.

Three places encode that:

- **`lib/src/sync/engine.rs:854`** — for every subject the server holds and the
  client's VV map omits, the server pushes a **full snapshot**. A fresh browser
  against a 100k-resource drive gets the entire drive pushed at it.
- **`lib/src/sync/engine.rs:863`** — the mirror case. A subject the client
  claims and the server lacks is pulled, or, if tombstoned, put on the `remove`
  list. Absence drives a *destructive* conclusion.
- **`compute_drive_hash` (`engine.rs:570`)** covers the whole drive's VV set and
  the fast path (`engine.rs:751`) compares it verbatim. A partial replica's hash
  can never equal a full peer's, so the in-sync short-circuit is permanently
  dead for exactly the devices that need it most: every reconnect pays the
  O(drive) VV exchange, forever.

The browser is *already* a de facto partial replica — `buildSyncPayload`
(`browser/lib/src/store.ts:1400`) reports only what its cache happens to hold —
and the server's answer to that is to refill it. Mobile is the same story with
less disk. So this is not a future large-drive concern; it is the current
behaviour of every non-server node, unmanaged.

## What has to be communicated

Not "what I don't sync" — that set is unbounded and derivable. Two things:

1. **Positive scope**, declared per drive per session: the subset this device
   wants replicated.
2. **Fill state** for that scope. Without it a peer cannot distinguish *"I lack
   X because it is out of scope"* from *"…because I have not caught up yet."*
   That distinction is the whole safety argument for a peer choosing not to
   push.

Everything else — what to push, what to prune, what to fan out — follows from
intersecting the two sides' declared scopes with the rights check that already
runs (`check_read` per subject, `engine.rs:795`).

Scope is **negotiated per direction and per pair**. The effective set a peer
sends is `their scope ∩ my scope ∩ what I may read to them`. A sender must never
push outside the receiver's declared scope, even when it holds the data and the
receiver is authorized — unsolicited data is what partial sync exists to
prevent.

## Scope shape: subtrees and blobs, not predicates

A predicate language is the tempting general answer and the wrong first move: it
has to be evaluated identically on both sides, in two languages, on every write.
Two axes cover the real cases:

- **Subtree roots.** With [`zones.md`](./zones.md) this is simply *"sync zones
  {A, B}"*, and partial sync becomes a payoff of the zone model rather than a
  second mechanism: that doc already names the zone as the unit of sync and
  calls for `collect_drive_subjects` → `collect_zone_subjects` (BFS stopping at
  nested zone boundaries) as its one wire-visible change. Without zones the same
  shape works on plain subtree roots via the parent-index BFS already in
  `collect_drive_subjects`. Either way the declaration is a handful of DIDs, not
  a subject list — a list would be O(drive) again and defeat the purpose.
- **Blob bytes**, independently: `none` / `on-demand` / `eager`. Today a device
  eagerly fetches blob bytes for everything it imports
  (`import_sync_push` → `BLOB_REQUEST`, `engine.rs:1106`). For real drives the
  bytes *are* the size problem, `BLOB_REQUEST`/`BLOB_RESPONSE` already exist as
  the lazy path, and this axis is nearly free.

Time windows ("the last 90 days of this feed") are the obvious third axis and
are deferred: they are the one form that cannot be answered from the parent
index, and flat high-churn collections are precisely where RBSR ranges, not
scope declarations, should do the work.

## The keyspace decision (do this before RBSR lands)

`rbsr.rs:44` fingerprints items keyed by **subject**, and DID subjects sort
randomly. A zone's resources are therefore scattered across the sorted keyspace,
so "scope = a set of ranges" does not hold and a scoped fingerprint would have
to be assembled item-by-item — O(scope), which is what the fingerprint tree
exists to avoid.

**Key RBSR items by `zone || subject` instead.** Each scope then becomes a
contiguous range set, a scope-relative root fingerprint falls out for free, and
the hash-first probe survives partial replicas. This has to be decided before
[`drive-reconciliation.md`](./drive-reconciliation.md) Phase 2 builds the
maintained tree; retrofitting the key means rebuilding it everywhere.

Note that `handle_sync_vv_filtered`'s `subjects: Option<&HashSet<String>>`
(`engine.rs:720`) is *not* this hook. It filters one exchange to a set the
caller already computed (the RBSR-differing set) and carries a documented
blob-backstop limitation; scope is a persistent declaration that must also
survive into the live channel.

## Two enforcement points

Bulk reconcile is half of it. `drive_subscriptions`
(`server/src/commit_monitor.rs:57`) fans **every** commit in a drive to every
subscriber of that drive, so an unfiltered live channel undoes the savings
within minutes of connecting. The resource-set subscription already in that
actor (`commit_monitor.rs:49` — "a set of resources without binding to a whole
drive") is the primitive the scoped case should build on rather than a third
subscription kind.

## Eviction is not deletion

`record_tombstone` (`lib/src/sync/tombstones.rs:18`) feeds the `remove` list.
If shrinking a device's scope goes through the ordinary local-delete path,
*"I dropped this to save disk"* propagates to every peer as *"delete this
everywhere."* Scope-shrink needs a distinct drop-local path that removes the
snapshot and leaves no tombstone. This is the one place partial sync can lose
data rather than merely waste bandwidth, and it deserves its own adversarial
test alongside the RBSR stale-node one.

The general invariant: **a partial replica's absence must never be the basis for
a destructive or corrective conclusion.** Out-of-scope absence produces no
`remove`, no push, and no "peer is behind" signal.

## Replicated vs reachable

Out-of-scope does not mean invisible. Browsing to a resource outside scope
should resolve over the same session via the existing `GET` frame, optionally
pinning it (a temporary one-subject scope extension). Framing scope as *what is
replicated* rather than *what is accessible* keeps it an offline-availability
setting instead of a visibility one — which is also what makes it safe to expose
in the UI, since getting it wrong costs connectivity, not access.

Once devices are partial, **"does any device still hold a full copy?"** becomes
a question someone has to be able to answer. Completeness accounting is the
backup story, and it is why fill state probably wants to be durable rather than
session-local.

## Impact inventory

| Area | Change |
| --- | --- |
| `lib/src/sync/protocol.rs` | `SYNC`'s JSON payload gains `scope` (+ fill state). Older peers ignore it and behave exactly as today — graceful, if wasteful, degradation. Wire reference in [`docs/src/websockets.md`](../docs/src/websockets.md) updated in the same change. |
| `lib/src/sync/engine.rs` | `handle_sync_vv_filtered`: the unknown-subject push (`:854`) and unknown-subject pull/remove (`:863`) both gate on the peer's declared scope. Snapshot push for out-of-scope subjects is dropped, not deferred. |
| `lib/src/sync/engine.rs` (blobs) | `import_sync_push`'s automatic `BLOB_REQUEST` becomes conditional on the blob axis. |
| `lib/src/sync/rbsr.rs` | Item key becomes `zone \|\| subject`; range fingerprints become scope-composable. |
| `server/src/commit_monitor.rs` | Drive fan-out filtered by the subscriber's scope, reusing the resource-set subscription path. |
| `lib/src/sync/tombstones.rs` + callers | New drop-local (no-tombstone) path for scope shrink, distinct from destroy. |
| `browser/lib/src/store.ts`, `websockets.ts` | Declare scope in the sync payload; stop treating a cold cache as "please refill me". |
| Flutter / desktop | Scope is the setting these platforms actually need surfaced ("this phone syncs Work only"). |
| UI | Per-device scope editor, out-of-scope = online-only affordance, and a drive-level "no device holds a full copy" warning. |

## Phasing

1. **Blob axis + no-refill.** Devices declaring a scope stop receiving
   full-snapshot pushes for subjects they never asked for, and stop eagerly
   pulling blob bytes. Largest byte win, smallest change, no keyspace decision
   needed.
2. **Subtree/zone scope.** Declaration on `SYNC`, scoped fan-out in
   `commit_monitor`, non-tombstoning eviction.
3. **Scope-relative fingerprint.** The `zone || subject` keying, so partial
   devices get the hash-first probe instead of an O(drive) exchange per
   reconnect. Sequence with `drive-reconciliation.md` Phase 2 — ideally the same
   piece of work.
4. **Completeness accounting.** Durable fill state, "who has everything",
   backup guarantees, UI.

Phase 1 is independently shippable and does not commit to any of the rest.

## Acceptance test

A phone scoped to one zone of a 100k-resource drive, syncing against a server
that holds all of it: initial fill transfers O(zone), reconnect after an
unrelated change elsewhere in the drive costs **one round trip** (probe matches,
because the fingerprint is scope-relative), and a commit in an out-of-scope zone
produces **zero** frames on the phone's live channel. Then shrink the scope and
confirm no peer deletes anything.

## Open questions

1. **Is scope session-local or persisted?** A session declaration is enough for
   the protocol. Persisting it as a `Device` resource in the drive is what makes
   completeness accounting (Phase 4) and cross-device UI ("what does my phone
   sync?") possible — at the cost of scope becoming replicated state with its
   own sync semantics.
2. **Does pinning an out-of-scope resource widen scope, or just cache it?**
   Widening is honest and durable; caching is invisible and risks a second,
   undeclared partial set the protocol doesn't know about.
3. **Server-side scope.** A hub declaring a partial scope is a different animal
   from a phone doing it (it interacts with admission/quota in
   `lib/src/sync/policy.rs` and with who is authoritative for a drive). In scope
   for the model, out of scope for the first implementation?
4. **Interaction with encryption.** Per-zone keys
   ([`encryption.md`](./completed/encryption.md)) make zone-granular scope natural — a
   device without a zone's key has no reason to replicate it. Does scope then
   become *derived* from key possession for encrypted zones?
5. **Does fill state need to be per-scope-element?** One flag per drive is
   simplest; per zone is what a device that is caught up on one zone and filling
   another actually needs to express.
