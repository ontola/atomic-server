# Persistence and copies

Atomic tracks **which version was stored, where, and which file bytes were
verified**. Saving, delivery, storage, and backup are separate observations.
An empty queue, a connected server, or a workspace's last-sync time cannot prove
that an individual item has a complete copy.

## One evidence model

Browser storage, server acknowledgements, durable server/peer receipts, and
Cloud Vault checkpoints use the client's `PersistenceEvidenceRegistry`.
Adapters retain responsibility for authentication, permissions, storage barriers,
and account/drive scope. The registry compares actual causal versions and
immutable attachment manifests; the UI reads these facts rather than inferring
success from transport progress.

| Observation | What it establishes |
| --- | --- |
| Local storage barrier | This snapshot completed a persistent browser-database write |
| Server acceptance | The authenticated endpoint accepted the sent change |
| Server or peer storage barrier | The named storage incarnation confirmed the target document version after its persistent flush |
| Verified contents | The required content hashes/chunks were verified at that destination |
| Vault checkpoint | The exported versions and verified contents were included in the acknowledged encrypted backup scope |

A later causal version can cover an earlier target. Persistent snapshot observations are never combined into a fictitious
version that no destination confirmed. Acceptance separately accumulates the
operations acknowledged by authenticated deltas. A file
rename can reuse content evidence; replacing its bytes changes its manifest.
For a complete remote copy, metadata and contents must name the same storage
identity and generation. Two sessions using one storage identity count once;
different identities alone do not prove separate physical devices.

## Online, offline, and unfinished work

For a browser database that supports durable persistence, delivery first writes
the snapshot and replay cursor together. Reconnect first merges any queued
snapshot into the live document, then checkpoints before delivery. Cold replay sends a queued genesis
and then any edits made after that genesis, including legacy queue entries that
omitted the baseline.

Committed edits to an existing offline or local-only resource schedule the same
serialized local-save pipeline. Until its barrier completes, the new version
is not locally confirmed. Storage errors remain visible through the save/status
API. An offline or local-only save rejects if its adapter cannot complete a
durable write. Browser eviction, deleting site data, and losing the device remain outside
the guarantee of a completed browser-storage write.

Saving a child of an unfinished parent checkpoints its entire unfinished ancestor
chain before the child in the encrypted local outbox. Each checkpoint retains
its parent dependency for recovery after restart; cyclic ancestry is rejected. These checkpoints are outside the published graph
and cannot drain on reconnect. Saving the parent releases the dependent saves.
A draft is not a server copy or a Vault backup merely because it was saved locally.

The embedded native renderer advertises no browser snapshot durability: its
snapshot RPC is a cache no-op. Native writes and receipts remain owned by its
host runtime. Memory adapters likewise cannot produce a persistent local receipt.

## Item status and recovery

`saveWithReceipt()` reports the boundaries completed by that save. Its status
string preserves the existing save API; it is not a durability guarantee by
itself. In `ResourceSyncStatus.server`, `accepted` and the legacy `state` describe
acceptance; `stored` describes persistent storage. The copy indicator uses
`stored`, together with the content evidence required by the current item.

Server storage receipts are recovered from private local metadata scoped to the
account, server origin, and drive. Learning a replacement storage generation
invalidates older receipts in that drive. Legacy acknowledgement records are
never upgraded to storage proof. Vault proof remains scoped to managed account,
portal, agent, drive, pseudonym, and key epoch. The new Vault receipt namespace
requires fresh evidence instead of trusting old combined version vectors.

Closing an item view stops its content polling without discarding its historical
observations. Local and server content history retain up to 512 unobserved items
per destination in the current Store; evicted history needs fresh verification.
Changing account or database still invalidates that history.

Disconnecting a browser peer or timing out a content query preserves the last
confirmed observation and its time; it does not establish current reachability
or retention. An authoritative missing-content result invalidates the content
proof. Browser peer history currently lasts for the Store's lifetime; after a
restart, peers must provide fresh receipts. Native peer snapshots remain
host-authoritative. Account, database, and destination changes fence delayed
callbacks, including switching away and back.

Existing missing-file recovery still verifies hashes before admitting recovered
bytes from peers or Vault. It does not replace newer document edits. A complete
item copy does not, by itself, prove a complete workspace backup, retained edit
history, a working decryption key, or a successful end-to-end restore.
