# Connection close cleanup

> Status: planned 2026-05-28. Correctness. Quick win.

## Problem

`WebSocketConnection` (the actix actor) registers itself into three
maps on subscribe:

- `CommitMonitor.subscriptions` (subject sub)
- `CommitMonitor.query_subscriptions` (filter sub)
- `LoroSyncBroadcaster.drive_subscriptions` (drive sub)

When the WebSocket closes, the actor stops. But its `Addr` is still
in those maps. The next `CommitMessage` fanout pass walks the map,
finds the stale addr, calls `addr.do_send(...)` — which silently
no-ops on a stopped actor. The entry is only cleaned up the *next*
time we walk and notice the send failed (some paths do this via
`Recipient::try_send`, others don't).

For long-running servers with churning connections, the maps grow
unbounded until the actor restarts.

## Proposal

Implement `actix::Actor::stopped` on `WebSocketConnection` to
explicitly unregister:

```rust
impl Actor for WebSocketConnection {
    type Context = WebsocketContext<Self>;

    fn stopped(&mut self, _: &mut Self::Context) {
        let my_addr = self.address.clone();
        self.commit_monitor.do_send(UnsubscribeAll { addr: my_addr.clone() });
        self.loro_broadcaster.do_send(UnsubscribeAll { addr: my_addr });
    }
}
```

`UnsubscribeAll` (new message) walks each map and removes any entry
whose `Addr` matches.

## Caveats

- `self.address` needs to be set in `started` (`ctx.address()`).
- `do_send` to a stopped actor's mailbox is safe; this runs on the
  *connection* actor's shutdown path, so `commit_monitor` and
  `loro_broadcaster` are alive.
- Don't rely on `Drop` — actix actors aren't dropped on close, they're
  stopped first then dropped on a `Context` cycle.

## Risk

Low. Worst case: the unregister itself fails silently, and we're no
worse off than today.

## Effort

~2 hours.

## Concrete steps

1. Add `Addr<Self>` field on `WebSocketConnection` populated in
   `started`.
2. Add `UnsubscribeAll` message to `actor_messages.rs`.
3. Implement `Handler<UnsubscribeAll>` on both `CommitMonitor` and
   `LoroSyncBroadcaster` (or, post-merge, just one).
4. Implement `stopped()`.
5. Add a test: open a WS, register two subs, drop the WS, assert maps
   are empty.
