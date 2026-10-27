# Choose transports and design for offline edits

Choose transports based on where your app runs, which replicas must communicate, and whether data must remain available when users close the app. `atomic_lib` is the component boundary; transports connect its sync engine to other replicas. Apps can combine transports, but must define connection, discovery and retry policies.

## Start with a topology

| App scenario | Starting point | What to account for |
| --- | --- | --- |
| Browser app with access across devices | Local persistence plus WebSocket sync to an AtomicServer | The server supplies an always-online replica. Show local, pending, accepted and rejected changes distinctly where they matter. |
| Sharing between open browsers without a data server | WebRTC | Requires a signaling service and sometimes TURN. The current room cap is eight members; this is an implementation limit, not a WebRTC limit. |
| Native Rust or Flutter devices connecting directly | Iroh | Supports dialing peers with NAT traversal and relay fallback. Devices must overlap online to exchange changes unless an always-online replica is also available. |
| Native app using a known AtomicServer | WebSocket | A direct server connection is sufficient; add Iroh when direct device pairing is needed. |
| Mixed browser and native clients | A shared AtomicServer | Browsers cannot directly speak Iroh. WebSocket provides a common meeting point. |
| Scripts and occasional server writes | HTTP, including `POST /commit` | Request/response access does not provide a live subscription. |
| Single-device app | Local persistence without a transport | Add synchronization when another replica is needed. |

For a browser app, local persistence plus WebSocket sync is a useful default. Add WebRTC when browser-only sharing is part of the product. For native apps, add Iroh when direct pairing or operation without a data server is required. Native transport APIs are feature-gated; see the [Rust library](../rust-lib.md).

Multiple transports do not imply automatic cross-transport discovery or seamless failover. Decide how the app finds replicas, authenticates and bootstraps them, starts connections, retries failures, and reports delivery status. Test the exact adapters and platforms you ship. See the [sync model](../sync.md) and [browser peer sync](../browser-peer-sync.md) for current behavior and verification limits.

## Availability is a separate decision

Signaling introduces browsers. TURN and Iroh relays forward traffic. None is an always-online storage replica. If every replica closes, another user must wait for a replica holding the needed data to return. Browsers can also suspend background tabs.

Use an always-online AtomicServer when users need access while their other devices are offline, or when background jobs and integrations must continue. This still requires persistent storage, backups, monitoring and a recovery policy. Replication alone is not a backup: unwanted edits and deletions can replicate too.

## Define application identity

Each table row is a Resource with its own Loro document. Concurrent edits to the same Resource merge, but independently creating two customers with the same email usually creates two Resources with different IDs. The transport does not recognize them as the same customer.

Decide which fields identify a business record, their scope and normalization, and what concurrent offline creation means. Options include retaining both records for review, selecting a primary while preserving references, or requiring an online authority for operations that need strict uniqueness.

Atomic has specific patterns to reuse:

- Content-addressed [Properties](../schema/property-identity.md) share an identity when their defining fields match. This is not a general-purpose mechanism for arbitrary customer records.
- [Import identities](../create-json-ad.md) use `localId` in a destination scope. A server rejects duplicate `(parent, localId)` claims during normal indexed writes, but independent offline peers can still create duplicates. Import review can select a primary and consolidate chosen values while retaining originals and links.
- First-party conversation and notification lists have their own display deduplication policies. Ordinary tables do not automatically enforce uniqueness of email, name or another business field.

## Separate merging from acceptance

CRDT convergence means accepted operations can produce a common state. It does not establish that the result satisfies a business rule, that an offline edit will be authorized when received, or that several Resources change as one application transaction.

For example, two offline devices may each try to reserve the last available item. Merging their records does not decide which reservation is valid. Financial settlement, stock allocation and other exclusive decisions need an explicit authority or coordination protocol. Offline actions can be drafts or requests until that decision is made.

Design how the app handles rejected writes, duplicate records, invalid combinations and stale permissions. Test reconnects after revocation, concurrent creation, device loss, and repeated delivery on every supported transport. A peer invitation introduces a replica; it does not grant application permissions or replace the current snapshot trust policy described in [browser peer sync](../browser-peer-sync.md).

Next: [migrating from PostgreSQL](8-from-postgres.md).
