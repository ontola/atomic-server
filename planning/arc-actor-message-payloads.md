# Arc-wrap actor message payloads (remaining)

> Status: partial. `MembershipNotification.loro_snapshot` Arc-wrapped
> 2026-05-28 (verified by WS test suite). This doc covers what's left.

## What's still done as `Vec<u8>`

`CommitMessage` carries an `atomic_lib::commit::CommitResponse` whose
inner `Commit` holds `loro_update: Option<Vec<u8>>`. When
`CommitMonitor::Handler<CommitMessage>` fans the commit out to N
drive/resource subscribers via `do_send(msg.clone())`, each clone
deep-copies the `loro_update` bytes. For a chat room with 50 connected
subscribers and an 8KB Loro update, that's 400KB allocated per commit
on the hot path.

## Why not landed yet

The fix would change `atomic_lib::commit::Commit::loro_update` from
`Option<Vec<u8>>` to `Option<Arc<[u8]>>`. That ripples through:

- `Commit` constructors (every test + every external API caller)
- `CommitResponse` serialization (the Commit gets serialized to JSON-AD
  in some paths; `Arc<[u8]>` needs custom serde)
- The HTTP commit handler (deserializes JSON → `Vec<u8>` → would need
  `Arc::from(...)` conversion)
- All `atomic_lib` consumers (SDKs, Flutter, CLI)

Out of scope for a "quick win" — this is a small `atomic_lib` RFC.

## Stretch: pre-encode the wire frame

Even better than Arc-wrapping the payload would be to encode the
`UPDATE` / `DESTROY` wire frame **once** in the fanout loop and Arc-
wrap the encoded bytes:

```rust
fn handle(&mut self, msg: CommitMessage, _: &mut Context<Self>) {
    let frame = Arc::<[u8]>::from(encode_update(&msg).into_boxed_slice());
    for sub in &self.subs {
        sub.addr.do_send(SendFrame { frame: frame.clone() });
    }
}
```

`SendFrame` is a thin Arc-carrying message that the `WebSocketConnection`
actor turns into `ctx.binary(...)`. One encode, N cheap clones.

This avoids the `atomic_lib` change entirely — the per-encoded-byte
deduplication lives only in the actor layer.

## Effort

- Atomic_lib change: ~1 day RFC + 1 day implementation + downstream
  fixups in Flutter/SDKs.
- Stretch (pre-encode frame): ~2 hours, contained to
  `server/src/commit_monitor.rs` and
  `server/src/handlers/web_sockets.rs`. Recommend doing this first; it
  delivers the perf win without touching atomic_lib.

## Concrete first step

Try the stretch path:

1. Add a `SendFrame { frame: Arc<[u8]> }` message to
   `actor_messages.rs`.
2. In `CommitMonitor::Handler<CommitMessage>`, build the encoded frame
   once, wrap in Arc, dispatch via `SendFrame` instead of cloning the
   whole `CommitMessage`.
3. Add `Handler<SendFrame>` on `WebSocketConnection` that just calls
   `ctx.binary(frame.as_ref().to_vec())` (or `Bytes::copy_from_slice`).
4. Benchmark with a synthetic 50-subscriber drive on a known commit
   stream.
