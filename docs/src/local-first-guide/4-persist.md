# Step 3: persist across reloads

The Store keeps resources in memory.
Durable storage in the browser comes from the **client database**: the same Rust store that powers AtomicServer, compiled to WASM, writing an encrypted file to the Origin Private File System (OPFS).
It runs in a dedicated worker; one tab per origin owns the file and the others talk to it over a `BroadcastChannel`, so several tabs share one database.

## Where the WASM comes from

The worker script ships inside `@tomic/lib`.
The WASM module does not, yet: it is built from the repository's `wasm/` crate and served by your app as static files.
Build it once and copy the two output files into your public folder:

```sh
# in a checkout of atomic-server
cd wasm
wasm-pack build --target web --out-dir pkg
cp pkg/atomic_wasm.js pkg/atomic_wasm_bg.wasm /path/to/your-app/public/wasm/
```

Publishing this as a package so the step becomes an `npm install` is on the [roadmap](../roadmap.md).

## Attach the database to the Store

```ts
import { ClientDbWorker, Store } from '@tomic/lib';
import workerUrl from '@tomic/lib/client-db.worker.js?url'; // Vite syntax

const clientDb = new ClientDbWorker(
  `${location.origin}/wasm/atomic_wasm.js`,
  workerUrl,
  {
    // One file per Agent, so two identities on the same origin never share a
    // cache. Derive the name from the subject however you like.
    dbName: `reading-list.${hash(agent.subject)}.redb`,
    // 32 random bytes. Keep them with the secret; without the key the file is
    // unreadable, which is the point.
    dbKey: loadOrCreateDbKey(agent.subject),
  },
);

const store = new Store({ agent });
store.setClientDb(clientDb);
await clientDb.init();
```

The order matters: attach first, then initialize.
Reads that happen while the worker is still opening the file wait for it instead of failing.

## What changes

- **Reads hit the database first.** `getResource` returns the stored copy without a network request, and only fetches when the resource is not present locally.
- **Writes are persisted with their history.** Each Resource's Loro snapshot is stored next to its properties, so version history survives a reload and offline edits made before a reload are still in the outbox afterwards.
- **Queries run locally.** `store.queryLocalDb` and `store.search` work against the local database, with the same index the server uses.

Reload the page: the Drive and the Book are still there, and the outbox still knows the Book has never been sent anywhere.

## Observe save completion

Await the save separately from changing a value:

```ts
await book.set(titleProperty, 'A new title');

try {
  const result = await book.save();
  // Inspect the result before proceeding with an action that needs the save.
} catch (error) {
  // Keep the editor open and offer retry when storage or connectivity recovers.
  console.error('The save did not complete', error);
}
```

For an offline save, or a resource in a local-only drive, the client database
must accept the resource snapshot and complete its flush before the save reports
success. Missing or unsupported local storage and failed writes reject the save.
Local-only saves retain their signed commits in memory after failure so retry can
store the original genesis and history; leaving the page before retry succeeds can
still lose those changes. A localStorage outbox alone does not store the resource
snapshot and cannot satisfy this requirement.

Interpret the result in context:

- `persisted` means the configured commit destination accepted the write, or a
  local-only resource completed its local write. For an online save, the subsequent
  local mirror is best effort: its failure does not undo remote acceptance.
- The offline persistence path returns `offline` after storing the snapshot and
  pending work locally for later delivery.
- `noop` means there were no changes to save; it is not a fresh storage receipt.

A child waiting for an unsaved parent only enters an in-memory batch; the local
persistence path has not run yet. Save the parent and await the child's own
completed save before relying on it. Older versions also return `offline` for
this case, so that result alone is insufficient proof of local storage.

Use `store.getSaveState(book)` and `store.subscribeSaveState(book, callback)` for
progress, or `useSaveState(book)` in React. These report `idle`, `dirty`,
`scheduled`, `saving`, `queued`, and `error`, with an optional `reason` and `error`
message. They describe work in progress, not a durable receipt for a particular
version. Awaiting a `useValue` setter only waits for local processing; with
`commit: true` it schedules a separate debounced save.

## Read version-specific receipts

Use `saveWithReceipt()` when an action needs to know which version reached which
boundary. It follows the same save pipeline and accepts the same `background`
option as `save()`, which continues to return only its status string.

```ts
await book.set(titleProperty, 'A new title');
const receipt = await book.saveWithReceipt();

if (receipt.local) {
  console.info('Local snapshot completed', receipt.local.version);
}
if (receipt.server) {
  console.info(
    'Server accepted this version',
    receipt.server.endpoint,
    receipt.server.commit,
    receipt.server.version,
  );
}
```

The exported `SaveReceipt` contains `status`, `subject`, and optional `local` and
`server` evidence. The result and its evidence objects are immutable.

| Evidence | Meaning |
| --- | --- |
| `local.version` | The base64-encoded Loro version captured with the snapshot whose local database write and flush completed. `null` identifies unversioned metadata. |
| `server.endpoint` | The actual commit endpoint used for the acknowledged request, including its origin and port. |
| `server.commit` | The identifier derived from the accepted signed commit. |
| `server.version` | The base64-encoded Loro version covered by that accepted commit. Later edits are excluded. |

Inspect the evidence fields independently. An online save can have server
evidence without local evidence when its optional local mirror fails or exceeds
the deadline. A local-only or offline save can have local evidence without server
evidence. The two versions may differ if another edit arrived between the server
request and the local snapshot. Compare versions using Loro's `VersionVector`
after decoding them; base64 strings are not ordered revision numbers.

Missing evidence makes no guarantee. A `noop` does not return a previous save's
receipts. A child waiting for its unsaved parent has neither evidence field,
regardless of its status label. Concurrent saves serialize: a second call with
no remaining work returns `noop`, not the first call's receipt.

Local evidence requires a storage backend that explicitly supports persistent
writes. The browser's OPFS worker supports this; the in-memory `NodeClientDb`
used by test/headless harnesses does not. An unknown adapter makes no local
durability claim. A custom host commit transport also makes no server-endpoint
claim: its completion alone does not show that the configured server accepted
anything.

An identity change invalidates the save attempt, even if the app switches back
to the original identity before completion. A local database replacement
invalidates local completion. Rejection does not undo writes or requests that
already began; these checks prevent stale completion evidence, rather than
providing a transaction cancellation protocol. A receipt names its captured
server endpoint; it does not certify a replacement server configured while the
request was pending.
Late completion of an optional local mirror cannot add evidence to an already
returned receipt.

Keep receipts with the identity and resource context of the call. They are
observations of completed operations, not independently verifiable certificates.

These receipts do not prove that a server flushed its disk or that an independent
second replica has the change. Tabs sharing one client database are one stored
copy, browser storage can be cleared or evicted, and a resource receipt does not
cover attachment bytes or all its linked resources. The SDK assesses replica evidence separately. Authenticated browser peers can
automatically produce the version-specific storage receipts described below.

## Automatic browser peer receipts

`BrowserPeerSync` automatically requests storage receipts from compatible,
authenticated browser peers. It uses the exact local and server versions captured
by completed saves, and checks stored versions during periodic reconciliation and
reconnection. Applications do not need to send a probe or construct an observation.

```ts
import { BrowserPeerSync, evaluateReplicaEvidence } from '@tomic/lib';

const peers = new BrowserPeerSync(store, {
  drive, room, signalingUrl, expectedPeer,
  onReplicaReceipt(receipt) {
    const signal = evaluateReplicaEvidence(
      {
        subject: receipt.observation.barrier!.subject,
        version: receipt.observation.barrier!.version,
        source: receipt.source,
        scope: 'device',
      },
      [receipt.observation],
      // Supply your explicit trusted independence policy as a third argument.
    );
    console.info(signal.status); // 'unknown' without that policy
  },
});
```

The immutable `BrowserReplicaReceipt` callback contains `observation`, the local
`source` storage identity, authenticated `peerAgent`, `drive`, and `connectionId`.
The `source` identifies the active local backing store for independence comparison;
the callback alone does not prove that store currently retains the target version.
Keep that context when your policy correlates the observation with a trusted peer
and configured storage/device relationship. Authentication identifies the reporter;
it does not establish that the peer is honest about storage or physically separate.
The SDK therefore does not automatically turn a received receipt into `satisfied`.
The callback observes completed evidence; it does not delay or strengthen `save()`.

The receiver checks that its stored resource state contains every operation in the
requested version, verifies drive/read access, and completes a persistent-storage
flush before replying. A later stored frontier can cover an older requested version:
`barrier.version` names that checked target, not necessarily the whole receiver
snapshot. A late C1 response remains evidence for C1 after the editor reaches C2.
Missing state, unresolved dependencies, deletion, memory storage and failed flushes
produce no positive receipt. Receipt requests are bounded and retried alongside
ordinary sync; they never publish unsigned edits or bypass normal authorization.
Probing is best effort and connection-scoped: old targets can be dropped on queue
overflow or retry exhaustion, so a callback is not guaranteed for every save.

Browser WebRTC peers use the Rust-backed persistent client database. Native Iroh
peers expose the equivalent receipt stream described below. Legacy peers continue normal syncing
without these receipt frames. Native Iroh full-sync confirmation and HTTP/WS server
acceptance remain separate contracts. No callback alone is not a replication failure
or evidence that a peer has retained nothing.

`await store.getClientDb()?.getReplicaIdentity(drive)` exposes the same drive-scoped
local identity used by the producer. Its private seed and generation are stored
atomically in the backing database before they are advertised; no global device
identifier is broadcast. Tabs sharing that database and later leaders report one
identity. Different drives receive different pseudonyms. Database recreation gets
new metadata; byte-for-byte copies retain the copied identity and conservatively
count as the same replica. Graph and Vault imports do not import identity metadata.
Memory and older backends return no persistent identity.

Replies must match a live request's nonce, drive, subject and version. Changing the
agent, database or connection invalidates outstanding requests, including switching
away and back. Callback evidence is not persisted as a retention ledger. Reconnection
can produce new evidence, and current retention or backup recovery still needs its
own policy and verification.

## Observe native Iroh receipts

With the Rust `iroh` feature enabled, subscribe on the database before opening a
peer connection or making changes:

```rust,no_run
# async fn example(db: atomic_lib::Db) -> Result<(), Box<dyn std::error::Error>> {
let mut receipts = db.subscribe_replica_receipts();
// Start/connect the native peer through the normal Iroh sync API.
loop {
    match receipts.recv().await {
        Ok(evidence) => {
            let receipt = &evidence.receipt;
            println!("{} covers {} at {}", evidence.remote_node_id,
                receipt.subject, receipt.version);
            // Compare evidence.source with receipt.replica under your own
            // trusted storage/device independence policy.
        }
        Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => continue,
        Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
    }
}
# Ok(())
# }
```

Native peers negotiate `iroh-storage-receipts-v1`, then automatically probe stored
resource versions after bulk reconciliation and during live sync, within the
drive bound by that connection's handshake. Other drives need their own
drive-bound sync session. Each queued
target keeps its captured version; a delayed response cannot become evidence for
a newer edit. Compare independently captured versions by decoding their Loro
version vectors: equivalent vectors can have different byte encodings. Wire
responses must still echo the exact version string from their pending request. Native change notifications can coalesce before a snapshot is
captured, so this API does not promise a receipt for every intermediate save.

`IrohReplicaReceipt` contains the wire `receipt`, local `source` storage identity,
verified `remote_agent`, authenticated QUIC `remote_node_id`, `local_agent`,
`connection_generation`, `agent_generation` and `observed_at`. Keep this context
when evaluating trust and independence. Node IDs, distinct storage IDs and an
ordinary sync acknowledgement do not establish separate devices. The same
resource-state coverage and persistent Redb flush checks serve browser and native
receipts; blobs, keys, retention and complete recovery remain separate.

The subscription is scoped to the backing database and shared by its clones,
including `with_own_agent` views, with bounded buffering and no replay. Hosts with
multiple agent views must filter `local_agent` and connection context; account
generations belong to the originating agent view, not a global account counter.
Subscribe first, handle lag, and treat observations as historical evidence. Account changes, connection replacement and disconnect fence
outstanding requests; reconnecting can produce new observations. Missing evidence
is not proof of replication failure. No application-issued probes are required,
and receiving a receipt does not change the return contract of native saves or
full-drive sync. Flutter/HTTP adapters must explicitly expose this Rust stream
before their callers can consume it.

## Observe HTTP/WebSocket server receipts

`Store` automatically requests storage evidence from compatible servers after
saves and background outbox delivery. While a drive is followed over WebSocket,
it also checks newly stored versions, including changes received from another
client and existing state after reconnect. Subscribe before connecting or saving:

```ts
import { StoreEvents, evaluateReplicaEvidence } from '@tomic/lib';

const unsubscribe = store.on(StoreEvents.ServerReplicaReceipt, evidence => {
  const barrier = evidence.observation.barrier!;
  console.info(evidence.serverOrigin, evidence.transport, barrier.version);
  const signal = evaluateReplicaEvidence(
    {
      subject: barrier.subject,
      version: barrier.version,
      source: evidence.source,
      scope: 'storage',
    },
    [evidence.observation],
    applicationReplicaPolicy, // Your trust, generation and independence policy.
  );
  console.info(signal.status);
});

const saved = await book.saveWithReceipt();
// A server receipt can arrive later. Match its exact subject and version to
// saved.local.version or saved.server.version according to your intended target.
// Call unsubscribe() when this observer is no longer needed.
```

No `saveWithReceipt()` call is required to start collection: ordinary `save()`
and delivery of previously queued edits use the same producer. A queued save's
original return value remains unchanged; later server evidence arrives through
the event. Stored-state collection reads the client database rather than unsaved
editor state. Several edits may coalesce before collection, so the event stream
does not promise a receipt for every intermediate version.

The exported `ServerReplicaReceipt` includes the immutable `observation`, optional
local `source` identity, `endpoint`, `serverOrigin`, actual `transport` (`http` or
`websocket`), `clientAgent`, `identityGeneration`, `databaseGeneration`, and
`connectionId`. There is no fabricated peer-agent identity: server provenance
comes from the configured HTTP/WebSocket origin and its transport security.
Production applications should use HTTPS/WSS and apply their own endpoint trust
policy. A client with only memory storage can receive a server receipt, but its
`source` is absent; that cannot establish an independent second persistent copy.

Servers advertise `server-storage-receipts-v1`. The separate receipt operation
checks the requested applied-state frontier, drive and current read permission,
then completes the same persistent Redb flush barrier used by peer receipts.
The returned version is the exact requested version, even if newer edits are
already stored. Ordinary HTTP `/commit` and WebSocket `COMMIT_OK` still mean
acceptance; `SaveReceipt.server` does not become a disk-flush guarantee.

Receipt work is bounded and best effort (128 queued targets, four concurrent
requests, six-second deadlines and three attempts per target). Reconciliation
inventories are refreshed and visited in rotating slices: at most 16 followed
drives, eight stored snapshots per slice and one in-flight scan per database.
A stalled database read cannot accumulate more scans. It runs separately from save completion;
unsupported servers, authorization refusals, missing state or failed barriers
produce no positive evidence. Account/database replacement and connection changes
discard stale requests. Applications do not issue probes, and absence of an event
does not prove replication failed. Observations are historical, with no replay or
retention ledger. They cover resource state, not attachment bytes, keys, physical
device independence, future retention or complete backup recovery.

Browser WebSocket authentication is serialized. Raw, failed or unmatched
authentication exchanges can leave an acknowledgement ambiguous because
`AUTH_OK` has no request identifier. Such a connection stops producing receipt
evidence until reconnect; ordinary commit acknowledgements remain a separate
contract.

### Native WebSocket and Flutter clients

Native clients collect the same server evidence automatically for followed drives.
Enable `atomic_lib`'s `ws` feature and subscribe before starting sync:

```rust,ignore
let mut receipts = db.subscribe_server_replica_receipts();
// Native replicate_drive_to_remote and Flutter's server sync start collection.
while let Ok(evidence) = receipts.recv().await {
    println!("{} stored {} at {}", evidence.server_origin,
        evidence.receipt.subject, evidence.receipt.version);
}
```

Applications managing a long-lived `WsClient` directly attach
`client::ws_receipts::WsReceiptSession::start(client, db)`, call `follow_drive`
for the drives they synchronize, and retain the session until `close`. This
collects evidence; it does not itself synchronize the drive. Native
`replicate_drive_to_remote` attaches collection for its bounded replication
attempt, including when the remote already has the same state.
Code that exhaustively matches `WsMessage` must handle its new `StorageReceipt`
variant. A raw frame is not correlated evidence; use the Db subscription above.

Flutter applications use the typed stream on their node:

```dart
final subscription = node.sync.watchReplicaReceipts().listen((evidence) {
  print('${evidence.serverOrigin}: ${evidence.receipt.subject} '
      'at ${evidence.receipt.version}');
});
await node.sync.connect(origin);
// Later, when the observer is no longer needed:
await subscription.cancel();
```

The native envelope includes the wire `receipt`, optional `source` storage
identity, `server_origin`, `connection_id`, `authentication_generation`,
`authenticated_agent`, `local_agent`, `agent_generation` and `observed_at`.
Flutter exposes the equivalent immutable fields in camel case. The authenticated
agent is the **client** identity accepted by the server; it is not a verified
identity for the server. Native replication can authenticate with a delegated
proof, so the authenticated client and local database agent may differ.
`observed_at` is the local observation time in Unix milliseconds; Flutter exposes
it as a UTC `DateTime`, not as a promise about the server's clock.

Targets are captured from stored applied state during initial inventories and
live changes, with periodic inventories recovering missed notifications. Edits
can coalesce before capture, so this is not a receipt for every intermediate
save. Each response echoes its exact requested version. When matching a separately
captured Loro frontier, compare decoded counters: equivalent vectors can have
different byte encodings. A collector follows at most 32 drives, queues at most
256 targets and keeps four requests pending, with five-second deadlines and three attempts. Native
one-shot replication gives collection a bounded response window, so it need not
produce evidence for every resource before returning. Pending work is discarded
when its account, authentication or connection changes. The stream has no replay; subscribe early and treat missing
observations as unknown. Flutter keeps a continuous subscription across reconnects
and filters evidence against its current sync session.

An untracked raw AUTH or canceled authentication attempt disables receipt
provenance on that WebSocket until reconnecting: AUTH acknowledgements have no
request identifier, so a delayed acknowledgement cannot safely certify a later
attempt. Ordinary synchronization remains separate from receipt eligibility.

These events do not change native save results, outbox delivery acknowledgements
or replication's `in_sync` result. The same endpoint trust, historical evidence,
optional source identity and metadata-only limitations described above apply.

## Assess independent-replica evidence

`evaluateReplicaEvidence` answers a narrower question: does the supplied evidence
establish at least one persistent copy of this exact resource version independent
of the local storage under the selected policy? It is a pure, synchronous SDK
function; it does not send a request, subscribe to peers, or wait for replication.

```ts
import { evaluateReplicaEvidence } from '@tomic/lib';

const receipt = await book.saveWithReceipt();
const signal = evaluateReplicaEvidence({
  subject: receipt.subject,
  version: receipt.local?.version ?? null,
  scope: 'device',
});
console.info(signal.status); // 'unsupported': no replica evidence provider
```

Choose `receipt.local.version` to ask about the locally persisted snapshot, or
`receipt.server.version` to ask about the version accepted by that server. Do not
silently substitute one for the other: concurrent edits can make them different.
A missing or `null` version cannot satisfy this version-specific requirement.

| Signal | Meaning |
| --- | --- |
| `unsupported` | No observation provider supports this evidence contract. This is the default when no observations are supplied. |
| `unknown` | A provider might support it, but required identity, provenance, generation or independence information is missing or cannot be trusted. |
| `pending` | A supported provider has not supplied a qualifying completed barrier for this target. This does not mean the SDK scheduled a transfer or that replication will eventually succeed. |
| `satisfied` | At least one supplied observation meets the selected policy for this exact target. |

The result includes its target, qualifying observations and excluded observations
with reasons. It is a detached immutable snapshot. Re-evaluate when your adapter
provides new evidence or your trusted policy changes; the function maintains no
cache or subscriptions and does not change `getSaveState()`.

### Integrate a trusted storage adapter

An adapter can pass `ReplicaObservation` records and a `ReplicaEvidencePolicy`.
The browser peer callback supplies this evidence automatically. Other adapters
can implement the same integration interfaces:

```ts
import {
  evaluateReplicaEvidence,
  type ReplicaEvidencePolicy,
  type ReplicaIdentity,
  type ReplicaObservation,
} from '@tomic/lib';

// Supplied by your adapter using authenticated evidence and operator knowledge.
// Neither SaveReceipt nor an Atomic peer ID supplies these facts today.
declare const localReplica: ReplicaIdentity;
declare const observations: readonly ReplicaObservation[];
declare const trustPolicy: ReplicaEvidencePolicy;

const signal = evaluateReplicaEvidence(
  {
    subject: receipt.subject,
    version: receipt.local?.version ?? null,
    source: localReplica,
    scope: 'device',
  },
  observations,
  trustPolicy,
);
```

A supported observation identifies its provider, the reporting storage replica
and generation, and a named persistence barrier bound to the subject and version.
Only explicitly persistent storage with a completed barrier can qualify. Memory
storage, an unknown capability, a pending or failed flush, or an ordinary commit
acknowledgement cannot qualify.

The policy's `assess(target, observation)` must independently establish trusted,
authorized provenance for the exact observation, current generations for both
source and destination, and independence under `target.scope`. Its assessment
returns `trust`, `generation` and `independence`. Trust includes validating what
the named barrier and backend actually promise, not just recognizing the sender.
An optional `evidenceId` can correlate the observation with an externally verified
record; the identifier itself proves nothing. The SDK does not authenticate a
peer or validate a signature for you. Do not implement the policy as an
unconditional trusted/independent response, or trust those claims merely because
a peer supplied them. Provider names, different storage IDs and device labels are
lookup keys, not proof. Missing policy information and policy exceptions fail
closed.

Use `scope: 'storage'` for separately backed storage, or `scope: 'device'` to
require independence from loss of the local device. Two tabs sharing the same
store never qualify as independent, including across a generation change. Two
separately backed browser stores on one laptop can meet a trusted storage policy
but cannot meet a device-loss policy. Scoped storage identities must be comparable
within the adapter's trust relationship; do not invent IDs from URLs, presence
sessions, Loro author IDs or browser fingerprinting.

This first contract requires exact equality of the captured version strings.
It does not infer coverage from a later or concurrent Loro frontier, timestamps,
commit counts or displayed values. A provider must supply evidence for the exact
target; a later frontier may contain it but will conservatively remain unproven
here. Repeated observations of the same store do not create additional copies;
the API assesses at least one qualifying replica, not a quorum or replica count.
In particular, do not use `qualifying.length` as a count of independent copies.

`satisfied` describes a historical completed persistence barrier under the supplied
policy. It does not promise current retention, recoverable backups, attachment
bytes, dependency closure, encryption-key availability, power-loss survival, or
acceptance by an authority. Disconnecting does not undo a historical write.
Resetting storage, deleting data or changing trust requires fresh adapter evidence
and policy assessment before presenting a current-copy claim.

The browser producer follows the [#2537 design](https://github.com/ontola/atomic-server/pull/2537)
and [#2244 contract discussion](https://github.com/ontola/atomic-server/pull/2244).
Additional transports and backup/retention guarantees remain follow-up work in
[#2538](https://github.com/ontola/atomic-server/issues/2538).
Existing commit acknowledgements, peer counts and full-sync timestamps must not
be converted into this evidence without the missing storage and trust facts.

## What you have

A single-device app that survives reloads, with an encrypted local database and version history, and still no server.
The next step adds one, so the reading list can reach a second browser and a colleague.

Next: [syncing to an always-on device](5-sync-server.md).
