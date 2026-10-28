{{#title Drive reconciliation: how two devices find what differs}}
# Drive reconciliation

When two devices meet, they have a simple problem: each has changes the other lacks, and sending the whole Drive every time would be slow and wasteful.
So they first work out _what differs_, and then send only that.
This is drive reconciliation. It is the same engine on every transport; the frames are specified in the [wire protocol](../websockets.md).

## Version vectors

To know what a device is missing, you need a compact way to describe what it has.
Every Resource is a Loro document, and a document's version vector records, for each peer that ever edited it, how many of that peer's operations the document contains.
Comparing two vectors tells you exactly which operations one side lacks.
A device builds the vector of every Resource it holds in the Drive and sends them in a `SYNC` frame. The vectors are compacted against a shared list of peer ids.

## Cheap check first

Sending every vector costs more as a Drive grows, and most of the time nothing has changed.
So the browser asks a cheaper question first.
It sends `SYNC` with a hash of its Drive state and a `probe` flag. The server computes the hash over the Resources that this Agent may read.
If the hashes match, the server answers `SYNC_OK` and nothing else is exchanged.
If not, it answers `SYNC_RESEND`, and the client sends its full vectors.

Over Iroh there is no probe. The initiator sends the full `SYNC` straight away, and a matching hash still short-circuits to `SYNC_OK`.

## The diff

The responder walks the Drive, compares vectors, and answers with a `SYNC_DIFF`:

- `pull`: Resources the responder wants from you.
- `push`: Resources it is about to send you.
- `remove`: Resources you should delete because it holds a tombstone for them.
- `pullFrom`: for each `pull` entry, the responder's own version vector. You then send only the operations after that point instead of a full snapshot.

Right after the `SYNC_DIFF` the responder sends its `push` list as one or more `SYNC_PUSH` frames. The last one carries a `LAST` flag.
The initiator applies the removals, imports what it received, and sends its own `SYNC_PUSH` frames for the `pull` list.
Both sides now hold the same data.

```
initiator                         responder
   SYNC (hash, probe) ---------->
                      <---------- SYNC_OK            (in sync, done)
                      <---------- SYNC_RESEND        (differs)
   SYNC (version vectors) ----->
                      <---------- SYNC_DIFF
                      <---------- SYNC_PUSH ... LAST
   SYNC_PUSH ... LAST ---------->
```

## Details worth knowing

- **Acknowledgements** apply to a chunk, not to each Resource in it. `SYNC_OK` after a `SYNC_PUSH` means the chunk was admitted. A sender that needs proof re-probes.
- **A refused push** is answered with an `ERROR` (`SYNC_REJECTED`) and nothing from it lands. This happens when the sender has no write right on the Drive, or the node's sync policy does not admit it.
- **Deletes** are tombstones, so that a reconcile doesn't bring a deleted Resource back. A live delete from a peer is applied as a signed destroy commit, checked like any other commit. A bare delete frame without a signature is ignored. In a reconcile, the `remove` list names deleted Resources, with the signed destroy commit attached where the sender still has it.
- **Files.** A File Resource syncs like any other, but its bytes are not pushed with it. The receiver requests them by hash (`BLOB_REQUEST`).
- **Live mode.** After the bulk exchange, the link stays open and each new commit is sent as an `UPDATE` frame. Edits in progress, cursors and presence travel as ephemeral frames and are never stored.
- **The outbox.** Local edits are queued as dirty Resources and drained to a peer in order. A failed delivery is retried with a backoff.

For the exact byte layouts, flags, chunk limits and error codes, see [Drive synchronization over WebSocket](../websockets.md#drive-synchronization-over-websocket), [over Iroh](../websockets.md#drive-synchronization-over-iroh) and [SYNC_PUSH chunking](../websockets.md#sync_push-chunking-and-acknowledgement).
The engine lives in `lib/src/sync/engine.rs` and the browser side in `browser/lib/src/ws-v2.ts`.
