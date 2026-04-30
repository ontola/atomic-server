# Drop QUERY_UPDATE — unify live events on UPDATE / DESTROY

> Status: implemented 2026-05-28. Builds on the May-21 narrowing
> (commit `dd771c29` — drive-wide QUERY_UPDATE limited to membership-only
> events). This plan removes the dedicated QUERY_UPDATE response frame;
> the `SUBSCRIBE_QUERY` *registration* primitive is kept (clients can
> still say "watch this filter") — only the wire shape of the response
> changes.

## Goal

Make the WebSocket protocol have **one channel** for "something happened to
a resource a subscriber cares about": `UPDATE (0x11)` for creates and edits,
`DESTROY (0x12)` for destroys. Stop emitting `QUERY_UPDATE (0x36)`. Keep the
three registration primitives (`SUB <drive>`, `SUBSCRIBE <subject>`,
`SUBSCRIBE_QUERY <json>`) — they're cheap, orthogonal, and a client may
genuinely care about "all resources matching this filter" without binding
to a whole drive.

## Why

After the May-21 narrowing, QUERY_UPDATE only fires on **membership changes**:

| Trigger | Old wire shape | New wire shape |
|---|---|---|
| Drive-wide `SUB`, new resource | `QUERY_UPDATE { added: [s] }` → client GET `s` → UPDATE | `UPDATE` with `SNAPSHOT \| PUSH \| HAS_COMMIT_ID` carrying the new resource directly (one round trip → zero) — already happens via `Handler<CommitMessage>`'s drive-wide fanout. |
| Drive-wide `SUB`, resource destroyed | `QUERY_UPDATE { removed: [s] }` + `DESTROY (0x12)` to resource subscribers | `DESTROY` to drive subscribers as well — already happens via `Handler<CommitMessage>`. |
| `SUBSCRIBE_QUERY` filter membership add | `QUERY_UPDATE { added: [s] }` | `UPDATE` (snapshot + commit_id pre-fetched by the `DbEvent` listener so the receiver doesn't need a follow-up GET). |
| `SUBSCRIBE_QUERY` filter membership remove | `QUERY_UPDATE { removed: [s] }` | `DESTROY`. |

Net effects:
- One client decoder path (`UPDATE` / `DESTROY`) instead of three (`UPDATE` /
  `QUERY_UPDATE` / text `SUBSCRIBE_QUERY` registrar).
- One round-trip on create instead of two.
- `shouldFetchOnQueryUpdate` heuristic goes away.
- Protocol surface shrinks: one tag becomes reserved, one text-frame
  registrar disappears.
- One concept fewer for new contributors.

The single real cost is bandwidth amplification: drive subscribers receive
the full Loro snapshot of every new resource in their drive, whether they
render it immediately or not. For realistic workloads (1–3 active tabs/
devices on a drive, mostly stub-sized new resources) this is on the order
of hundreds of bytes per create — noise. High-fanout public-drive scenarios
would pay more; deferred until a real workload exists.

Choice made 2026-05-28: **full snapshot inline** (vs. notification-only or
size-thresholded hybrid). Cleaner client code, fewer states to test.

## Surface

| Layer | What changes |
|---|---|
| `lib/src/sync/protocol.rs` | Keep `tag::QUERY_UPDATE = 0x36` as a **reserved** constant (don't reuse the byte). Delete `encode_query_update` / `DecodedQueryUpdate` / `decode_query_update` and their tests. |
| `server/src/commit_monitor.rs` | Keep `query_subscriptions` map and the `MembershipNotification` listener; the listener now pre-fetches snapshot + commit_id for additions and forwards to subscribers, who encode `UPDATE` / `DESTROY` (instead of `QUERY_UPDATE`). |
| `server/src/handlers/web_sockets.rs` | Drop the `Handler<QueryUpdate>` impl. Keep the `SUBSCRIBE_QUERY` text-frame branch. New `Handler<MembershipNotification>` impl on `WebSocketConnection` encodes the UPDATE / DESTROY frame for the receiver. |
| `server/src/actor_messages.rs` | Remove `QueryUpdate`. Keep `SubscribeQuery`, `UnsubscribeQuery`, `MembershipNotification` (the latter now carries pre-fetched `loro_snapshot` + `commit_id`). |
| `browser/lib/src/ws-v2.ts` | Delete `decodeQueryUpdate` and `DecodedQueryUpdate`. Keep `Tag.QUERY_UPDATE = 0x36` exported as a reserved constant — clients should not reuse the byte. |
| `browser/lib/src/websockets.ts` | Delete the `case Tag.QUERY_UPDATE:` branch (binary path) and the `text.startsWith('QUERY_UPDATE ')` branch (legacy text). Delete `shouldFetchOnQueryUpdate` (no callers — UPDATEs carry the snapshot inline). |
| `flutter/rust/src/api/simple/ws_sync.rs` | Delete the `client.subscribe_query(parent, drive, drive)` call — `subscribe_drive` already covers that specific case (every resource under the drive). The `subscribe_query` API itself stays on `WsClient` for future callers that want filter subscriptions. |
| `docs/src/websockets.md` | Mark tag `0x36` reserved. Remove the "Query Update Notifications" section. Keep `SUBSCRIBE_QUERY` in the text-frames list with the new wire-shape description. |
| `planning/sync.md` | Tick the "narrow QUERY_UPDATE" status item and add a "Superseded by `drop-query-update.md`" pointer. |

## Rollout order

The whole change is small enough to ship as one PR, but the *order of edits*
inside that PR matters so intermediate compile states stay clean:

1. **Server first**: re-route the drive-wide create/destroy events to UPDATE /
   DESTROY. Keep QUERY_UPDATE emission as a no-op-shaped redundancy *or*
   delete in the same step (both server and browser change atomically).
2. **Browser + Flutter**: stop expecting QUERY_UPDATE. Stop calling
   `subscribe_query`. Verify drive views update on resource create/destroy via
   the UPDATE / DESTROY pipeline.
3. **Protocol & docs**: trim encoders/decoders, mark `0x36` reserved, rewrite
   the doc sections.
4. **Tests**: convert `server/tests/query_subscribe.rs` into
   `server/tests/ws_drive_membership.rs`, asserting:
   - drive subscriber receives `UPDATE` with `SNAPSHOT|PUSH|HAS_COMMIT_ID`
     when a new resource is created in the drive;
   - drive subscriber receives `DESTROY` when a resource is destroyed;
   - resource subscriber also receives both (no regression);
   - originating connection does *not* receive its own create-UPDATE (source
     suppression survives).

The `query_subscribe_requires_read_permission` test is essentially asserting
the permission gate on registration; the equivalent for the new world is the
existing `SUB` permission gate, which is already covered. That single
sub-test can fold into the new file or be deleted.

## Compatibility

This is a breaking protocol change. Acceptable because:
- The protocol is currently versioned `atomicdata-ws.v2` and has no external
  consumers beyond this repo's clients (browser, Flutter, Rust CLI).
- All three clients land in the same change.
- Old text-frame `SUBSCRIBE_QUERY` was already a deprecated transition path
  that the v2 binary protocol was meant to retire.

No protocol-version bump is required (we keep `v2`); the change is wire-
compatible with any v2 receiver that ignores unknown tags, and we delete
all known emitters of the obsolete tag.

## Test impact

| Existing test | Disposition |
|---|---|
| `server/tests/query_subscribe.rs` (5 tests) | Convert to `ws_drive_membership.rs`. The permission-gate test folds into the existing `SUB` permission coverage. |
| `lib/src/sync/protocol.rs` codec tests | Delete the `query_update_*` cases. |
| `lib/src/sync/tests.rs::synced_resource_appears_in_query` | Re-name / re-shape as "synced resource appears via UPDATE". |
| Browser unit tests (if any) referencing `decodeQueryUpdate` | Delete. |

## Open questions

- **Should `Tag.QUERY_UPDATE = 0x36` stay reserved or be deleted?** Reserved
  is safer (avoids accidental reuse if someone reads old client code and
  picks the same byte for something else). Default: keep as a constant with
  a `// reserved — do not reuse` comment.

- **Filter subscriptions for *future* use cases.** Right now nothing uses
  `SUBSCRIBE_QUERY` from the browser, and Flutter's use is equivalent to
  drive-wide. If we later want "subscribe to all messages in chat room X",
  we can either (a) extend `SUB` to take a richer subject (e.g. parent-
  scoped), or (b) reintroduce a filter-subscription primitive with a
  different name and tag. Out of scope for this change.
