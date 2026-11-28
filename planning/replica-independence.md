# Replica identity and durable acknowledgement

Status: **Proposal**, 2026-11-16. Design only; the identity and acknowledgement
contracts below are not implemented. Verified behavior refers to `develop`
`f445d29`. This work is independent of the TablePage extraction and preserves
the public `<InputString resource={resource} property={property} />` API.

## Recommendation

Represent a runtime session, a persistent storage replica and a failure domain
separately. Track durability evidence for a particular change/version. Report
local durability, independent replication and authority acceptance as separate
facts, rather than promoting a connected-peer count or a generic “saved” flag
into all three promises. Unknown evidence remains unknown.

Two tabs sharing browser storage are one storage replica. Two browsers on one
device can hold separate storage replicas while sharing the device's failure.
An acknowledgement from one independent storage replica can satisfy a configured
replication requirement without establishing acceptance by an authority. The same
remote node can provide both facts, but each needs its own evidence.

Owning plans: [runtime boundary](atomic-lib-runtime.md),
[unified sync](unified-sync.md) and [browser data layer](unified-data-layer.md).
The [wire reference](../docs/src/websockets.md) remains authoritative for the
existing protocol; this proposal does not assign new frame tags or capabilities.

## What exists today

| Verified implementation | What it establishes; what it does not |
| --- | --- |
| [`ClientDbWorker`](../browser/lib/src/client-db.ts) elects one leader per database name with Web Locks; follower tabs forward calls over BroadcastChannel. | Several tabs access the same OPFS database. A tab, worker or leader transition is not an extra copy. |
| [`browserPeerId`](../browser/lib/src/browser-peer-sync.ts) hashes a localStorage browser secret with agent and room, retaining a shared prefix and random session suffix. Matching prefixes are skipped when adding members. Without storage it returns a random token. | Existing same-browser connection deduplication. Neither a persistent backing-store identity nor proof of independence; storage failure must not become a claim of a new durable replica. |
| [`presenceSessionId`](../browser/lib/src/store.ts) is generated for a Store; [`presence.ts`](../browser/lib/src/presence.ts) distinguishes sessions. | Presence/runtime identity, not a count of stored copies. |
| [`peer.rs`](../lib/src/sync/peer.rs) stores an Iroh secret key and optional device name in the database. | A persistent transport key and display label. No general storage-replica/failure-domain contract is exposed; a name is not device evidence. |
| Loro version vectors identify operation authors/counters. | Content/version evidence. A Loro peer ID is not a persistent storage-replica ID. |
| [`putResourceWithSnapshot`](../browser/lib/src/client-db.ts) acknowledges a batched snapshot/index/outbox write after worker flush. [`KvStore::flush`](../lib/src/db/kv_store.rs) is a durability barrier, but is documented as a no-op for memory backends. | A useful local persistence seam, subject to the backend's actual capability. A fulfilled flush alone does not prove persistent storage. |
| [`CommitAck`](../lib/src/sync/engine.rs) returns full/slim commit identity and optional pacing. Browser [`sendCommit`](../browser/lib/src/store.ts) uses WS or HTTP and updates the outbox after success. | Commit-response correlation and existing ingest policy. No advertised independent-storage identity, failure-domain relation or per-change durable-copy receipt. Do not silently strengthen `COMMIT_OK`. |
| [`SYNC_PUSH` completion](../docs/src/websockets.md#sync_push-chunking-and-acknowledgement) flushes accepted state before the final chunk acknowledgement. Individual entries can be skipped; intermediate acknowledgements are receipts. A sync probe also uses `SYNC_OK`. | Neither an arbitrary `SYNC_OK` nor a completed connection proves a particular change is retained by an independent durable replica. |
| [`SaveStatusCoordinator`](../browser/lib/src/save-status-coordinator.ts) derives dirty/scheduled/saving/queued/error/idle from scheduling, outbox and resource state. | Existing save progress; `idle` does not enumerate durable remote copies. This proposal is not a replacement scheduler or state manager. |

## Identity at the storage boundary

Proposed identities and metadata:

- **Runtime/session ID:** ephemeral, changes on a new runtime/session. It is
  useful for routing, request correlation and fencing stale responses.
- **Storage replica ID:** opaque random identity created atomically in the
  backing store's metadata and made durable before it can be advertised as
  persistent. All processes, tabs and connections using that store report the
  same identity. Reopening it or electing a new browser leader retains it.
- **Storage generation:** distinguishes replacement/reset from the previous
  store. Old receipts cannot describe a newly empty store under a reused name.
- **Optional failure-domain relation:** scoped information about shared device,
  disk/volume or hosting failure, with source and trust level. Its default is
  unknown. A display name, origin, IP address, transport key or different agent
  is not enough to infer a different device.
- **Durability capability:** explicitly persistent with a documented barrier,
  volatile, or unknown; include known scope/retention limits. Failure to open
  persistent storage cannot fall back to advertising persistent capability.

The exact names/encoding remain open. Store-local metadata belongs below React
in the storage/runtime layer, surfaced through WASM/native bindings and the JS
SDK. Assigning a fresh ID in every UI provider would reproduce the tab-counting
problem. The existing browser-prefix heuristic can remain for connection
deduplication while this contract is introduced.

| Situation | Proposed interpretation |
| --- | --- |
| Two tabs, same agent/database in the same browser storage partition | One storage replica, several runtime sessions; never counts as an independent copy of itself. |
| Different browsers, or isolated profiles/partitions, with separately backed databases | Can be distinct storage replicas; device independence remains unknown unless separately established. A second database on one device is not device-loss protection. |
| Several remote processes/connections accessing one database | One storage replica. Different URLs, process IDs, Iroh keys or sockets do not add copies. |
| Separate databases sharing a volume, host or replicated backend | Describe known common failure domains; do not count connections to the same underlying copy as separate storage. Resolve backend replication policy explicitly. |
| In-memory/test runtime, unavailable storage, private/ephemeral storage | Volatile or unknown/limited capability as appropriate. It can collaborate, but cannot promise an independent durable copy merely because flush returned. Private browsing does not itself prove that storage is memory-only. |
| Backup restore, database clone or storage reset | Identity/generation migration needs an explicit policy. A copied ID must not be counted twice; a restore must not revive old receipts as evidence of present content. |

Different opaque IDs alone cannot prove different physical storage. Start with
trusted local adapter knowledge and authenticated peer reports, recording their
provenance and limits. A policy that needs stronger independence requires
operator/user configuration or other trusted evidence. Do not turn absence of
known overlap into positive proof of independence.

## Evidence for a particular change

A proposed durable receipt identifies the reporting storage replica/generation,
the subject and exact change or covered version frontier, the persistence
capability/barrier used, the authenticated reporter, and the request/session it
answers. A receiver emits it only after checking that the claimed content is
present and its relevant write and receipt metadata crossed the barrier. A
flush error emits no durable receipt. An acknowledgement lost after flush is
safe to retry or re-probe idempotently.

For signed changes a commit identity may identify the change, but it must cover
the actual acknowledged content. For coalesced local edits before sign-at-drain,
capture a local change/version reference and map subsequent signed output back
to it. Select that representation after the `useValue` contract discussion;
this plan does not add a second edit queue or require signing every keystroke.
Version-vector coverage must include the target change and be scoped to the
subject; a recent timestamp, larger row count or equal displayed value is not
proof. Deletes/tombstones require their own retained evidence. Blob bytes and
retention are separate from metadata unless explicitly included in the receipt.

Applications can then ask distinct questions:

1. Has change C crossed the local persistent-storage barrier?
2. Has C crossed a barrier on at least one storage replica known to be
   independent of the local replica, under this policy?
3. Has C been accepted by the relevant authority under its validation policy?
4. If required, is a durable copy of C known outside the local device/failure
   domain, and what retention promise supports that statement?

These are orthogonal observations. A peer can store a signed change that an
authority later rejects. Authority acceptance by an in-memory node supplies no
persistent copy. An authority can also be the independent durable replica, but
only with the corresponding identity and persistence evidence. Receipt for C1
does not cover a later edit C2. A stale session's response cannot mark the
current edit or a replacement store durable.

Keep accepted receipts separate from current reachability and retention: a
disconnect does not undo a historical flush, and a historical flush is not a
promise that the peer still retains the change after deletion or eviction.
Expose the evidence/policy rather than one universal “safe” boolean.

## Authentication, privacy and compatibility

Bind advertised replica metadata and receipts to the authenticated connection
or signed response, including the authorized resource/drive scope. Identity
authenticates the reporter, not the truth of its storage claims; an arbitrary
peer cannot manufacture a trusted independent-backup guarantee by inventing IDs.
Replication evidence must never grant data access or bypass commit validation.

Keep a raw storage identity private where possible. Negotiate scoped pseudonyms
per trust/replication relationship; do not broadcast a global hardware/device
identifier or derive one through browser fingerprinting. Identity-scoping must
still let a policy deduplicate the same store across its relevant connections.
Device/failure-domain disclosure is optional and permissioned; unknown is a
valid result, including across browsers on the same device. How pseudonyms are
compared across overlapping scopes is an explicit design decision.

Negotiate any future wire capability. Old peers retain their existing sync and
commit behavior, with independence/durable-receipt evidence reported as unknown
or unsupported. Never reinterpret old `SYNC_OK`, `COMMIT_OK` or presence as the
new receipt. Only update the public protocol reference when encoding and
semantics have been selected and implemented.

## Incremental implementation seams and acceptance

- [ ] Define the smallest SDK/runtime descriptor and evidence vocabulary after
  the binding contract discussion. Document exact policy and unknown states.
- [ ] Persist storage identity/generation at the `Db`/`KvStore` boundary; add a
  capability contract for memory/custom stores. Expose it through `AtomicNode`,
  WASM ClientDb and native adapters; all browser followers query the leader.
- [ ] Characterize existing local barriers and failure paths with crash/reopen
  tests; reuse `putResourceWithSnapshot` and native flush boundaries rather
  than adding a competing persistence layer.
- [ ] Add an opt-in authenticated per-change receipt/re-probe capability to the
  shared sync engine. Check both individual commit and bulk-sync paths; skipped
  entries, intermediate chunks and read-only peers must not produce false proof.
- [ ] Surface receipt observations through SDK subscriptions; let existing
  resource-aware components consume binding status without changing their
  resource/property syntax. Integration with ELFA is a separate implementation.
- [ ] Prove same-store tab/process deduplication, leader handoff, distinct browser
  partitions, local-only/offline writes, memory-only peers, failed flush, lost
  ack/reconnect, old peers, clone/reset and C1-ack-after-C2 races. Test shared
  device/volume cases and unknown failure domains explicitly.

No implementation sequence should block ordinary local edits while waiting for
remote durability. Applications may choose a stronger completion policy, but
must distinguish waiting for evidence from refusal/validation errors.

## Decisions still needed

1. What minimum evidence/trust policy establishes separate storage, and which
   stronger policies require device/host independence? Is one independent
   storage replica the default, with device-loss protection explicitly separate?
2. What are identity/generation rules for backups, cloned databases, account
   migration and custom/shared backends? How is identity creation atomic across
   processes without pretending to solve their existing concurrent-writer rules?
3. Which pre-signing change reference/frontier can both Atomic and ELFA expose,
   and how does it map to authority acceptance and multiple-field saves?
4. How are scoped pseudonyms deduplicated without unnecessary cross-room or
   cross-drive tracking? Who may disclose/confirm shared failure domains?
5. Is a receipt only historical durability, or also a retention lease? Which
   resource state, signed envelope, tombstone and blob retention is promised,
   and how are eviction/reset and encrypted-storage key loss reported?
6. Which backends can truthfully advertise each barrier guarantee? Distinguish
   process crash/reopen, OS/power failure and eventual storage eviction instead
   of promising all three from a successful API call.
