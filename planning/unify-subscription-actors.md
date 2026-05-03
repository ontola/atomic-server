# Unify subscription actors

> Status: planned 2026-05-28. Cleanup. Pairs with
> [unify-subscription-primitives.md](./unify-subscription-primitives.md).

## Problem

Two actors run side-by-side and do nearly the same job:

- **`CommitMonitor`** (`server/src/commit_monitor.rs`)
  - Owns `subscriptions: HashMap<Subject, HashMap<Addr, source_id>>`
    (subject sub) and `query_subscriptions: HashMap<Vec<u8>, ...>`
    (filter sub).
  - Receives `CommitMessage` from `Db::on_commit` → fans out
    `UPDATE` / `DESTROY` to all matching subscribers.
  - Receives `DbEvent::QueryMembershipChanged` → fans out
    `MembershipNotification` to filter subscribers (already
    pre-fetches `loro_snapshot` + `commit_id`).

- **`LoroSyncBroadcaster`** (`server/src/handlers/web_sockets.rs`)
  - Owns `drive_subscriptions: HashMap<String, HashMap<Addr, source_id>>`
    (drive sub).
  - Receives `CommitMessage` → fans out `UPDATE` / `DESTROY` to drive
    subscribers (subjects under a drive URL prefix or DIDs in the
    workspace).

Both subscribe to `CommitMessage` independently. Every commit:

1. Goes through `Db::on_commit` once.
2. Sent to `CommitMonitor::Handler<CommitMessage>` (full Loro snapshot
   borrow + per-subscriber clone of the wire frame).
3. Sent to `LoroSyncBroadcaster::Handler<CommitMessage>` (same again —
   re-decodes the resource, re-encodes the wire frame).

Two actor mailboxes, two locking domains, two fanout passes per commit.

## Proposal

Fold `LoroSyncBroadcaster` into `CommitMonitor`:

```rust
struct CommitMonitor {
    store: Db,
    subs: HashMap<Addr<WebSocketConnection>, Vec<Subscription>>,
}
```

Where `Subscription` is the unified shape from
[unify-subscription-primitives.md](./unify-subscription-primitives.md).
A single `Handler<CommitMessage>` impl walks `subs` once, encodes the
`UPDATE` / `DESTROY` frame once (as `Arc<[u8]>` — see
[arc-actor-message-payloads.md](./arc-actor-message-payloads.md)), and
dispatches to each matching connection.

This eliminates one of the two actors entirely, reduces locking, and
shrinks the fanout cost.

## Risk

Naming becomes muddy if we keep `CommitMonitor` as the merged actor.
Rename it `SyncBroadcaster` (or `SubscriptionRegistry`) so it doesn't
read as "an actor that watches commits" — it's the broker between
commits and connections.

The `Db::on_commit` callback can keep pointing at the renamed actor;
that's a one-line change.

## Effort

- 0.5 day for the merge (the two handlers are short).
- 0.5 day to rewire the `Db::on_commit` registration.
- Cleanup PR.

## Concrete steps

1. Land [unify-subscription-primitives.md](./unify-subscription-primitives.md)
   first (single map shape).
2. Move `drive_subscriptions` logic into the merged actor.
3. Delete `LoroSyncBroadcaster` and its `Addr` plumbing in
   `AppState`.
4. Rename the actor.
