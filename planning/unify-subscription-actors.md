# Unify subscription actors

> Status: **done 2026-09-05.** Cleanup. Pairs with
> [unify-subscription-primitives.md](./unify-subscription-primitives.md).
> `LoroSyncBroadcaster` is gone; its Loro-ephemera and drive-presence maps
> live on `CommitMonitor`. The actor was not renamed — `CommitMonitor` is
> the name every WS/commit path already uses, and a rename is leftover
> cosmetic work.

## Problem

Two actors used to run side-by-side. The plan as written in 2026-05 still
described `LoroSyncBroadcaster` as owning **drive commit fan-out**; that
had already moved to `CommitMonitor` (`drive_subscriptions`, encode-once
`SendFrame`). What was left on `LoroSyncBroadcaster` was the non-persisted
realtime channel:

- Loro doc sync (`SubscribeLoroSync`, `LoroSyncUpdate`, `LoroEphemeralUpdate`)
- Drive presence (`SubscribePresence`, `PresenceUpdate`, `RemotePresenceUpdate`)
- `UnsubscribeAll` on WS close

Two actor mailboxes, two `UnsubscribeAll`s, two `Addr`s on every
`WebSocketConnection` and on `AppState`.

## What landed

`CommitMonitor` gained `loro_subscriptions` and `presence`. Every handler
that used to live on `LoroSyncBroadcaster` is on `CommitMonitor`. A single
`UnsubscribeAll` on socket close walks all four maps. `AppState` and the
WebSocket actor hold one `Addr`. `serve.rs` relays inbound Iroh ephemera
to the same actor. Behaviour is unchanged: write check on `DOC` updates,
presence replay to late joiners, peer relay with no echo.

Rename to `SyncBroadcaster` was skipped; the name is load-bearing in
docs and tests and does not match the leftover work.

## Concrete steps (done)

1. Land [unify-subscription-primitives.md](./unify-subscription-primitives.md)
   first (single map shape).
2. Move Loro/presence maps into `CommitMonitor`.
3. Delete `LoroSyncBroadcaster` and its `Addr` plumbing in `AppState`.
4. ~~Rename the actor.~~ leftover
