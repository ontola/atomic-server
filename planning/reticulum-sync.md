# Reticulum transport for Atomic sync

## Goal

Make the Atomic sync protocol work over Reticulum, so Atomic nodes can sync over
mesh links without internet, DNS, HTTP hosting, or an Iroh relay.

Reticulum should be a transport for the existing Atomic peer protocol, not a new
sync model. The same resource, commit, blob, and Loro frames should work over:

- WebSocket
- Iroh QUIC
- Reticulum
- future transports

## Thesis

Atomic sync should be framed as:

```text
Atomic sync engine
  AUTH / COMMIT / UPDATE / DESTROY / SYNC / SYNC_DIFF / SYNC_PUSH / BLOB_*
        |
        v
AtomicTransport
        |
  WS | Iroh | Reticulum
```

Reticulum handles reachability over mesh networks. Atomic still handles:

- resource identity
- agent authentication
- authorization
- signed commits
- Loro state exchange
- blob identity and transfer

Reticulum destination identity must not become authorization. A reachable
Reticulum peer is only a route. Atomic `AUTH` and normal read/write checks still
decide what data can move.

## Existing Groundwork

- `docs/src/did.md` already describes Reticulum-compatible `did:ad` resolution.
- `docs/src/did.md` currently suggests deriving a 16-byte Reticulum routing value
  from the drive DID; this plan treats that as needing verification against the
  Reticulum destination model.
- `planning/unified-sync.md` already wants a transport-neutral sync API.
- `planning/atomic-lib-runtime.md` sketches an `AtomicTransport` boundary.
- `lib/src/sync/protocol.rs` already encodes the binary v2 frames.
- `lib/src/sync/engine.rs` is transport-agnostic for `SYNC`, `SYNC_DIFF`, and
  `SYNC_PUSH`.
- `lib/src/sync/peer.rs` is an Iroh-specific adapter and a good reference for
  what Reticulum should eventually replace or sit beside.

## Product Use Cases

- Two laptops exchange drive updates over local mesh with no internet.
- A phone syncs with a home node over Reticulum instead of a public server.
- LoRa / serial / radio links carry sparse Atomic updates where bandwidth is
  low and latency is high.
- A community mesh node acts as an optional replica for selected drives.
- Blob transfer works opportunistically when the mesh path can carry it.

## Addressing and Discovery

Use the DID plan as the starting point:

- A Drive DID is the stable Atomic identity.
- A Reticulum destination announces that a node can serve or sync one or more
  Atomic drives.
- Announce `app_data` should include the drive DID or a compact hash of the drive
  DID, plus a protocol/version marker.
- Clients discover peers for a drive from Reticulum announces, then open a Link
  to the announced destination and run Atomic `AUTH`.

The derived Reticulum destination should be treated as a routing key only. The
session must still start with Atomic `AUTH` for the requested drive.

Spec note:

- Reticulum destinations are 16-byte hashes, but they are normally derived from
  the Reticulum Identity plus app name/aspects, not from an arbitrary application
  string alone.
- `docs/src/did.md` currently says Reticulum uses
  `truncated_SHA256(drive_did_string)` for drive discovery. That needs review
  against the actual Reticulum destination model. The practical design is likely
  an Atomic app destination, with the drive DID carried in announce app data or
  an aspect namespace, rather than a raw drive-DID-addressed destination.

Open implementation detail:

- choose the destination naming scheme, likely `atomic.sync` plus aspects such
  as `drive.<drive_hash>` if Reticulum RS supports that cleanly.
- decide whether one node announces one destination per drive or one node-level
  destination with drive availability in `app_data`.

Tradeoff:

- **One destination per drive** makes Reticulum announce filtering precise and
  avoids an extra lookup after path discovery, but it may create too much
  announce traffic for nodes with many drives.
- **One node-level destination** keeps announce volume low, but clients must
  establish a Link and ask which drives/capabilities are available. This is
  better for low-bandwidth meshes and private drives.

Default recommendation for first pass: node-level destination plus compact
`app_data` capability hints. Add per-drive announce as an opt-in for public or
community replicas.

## Transport Shape

Add a feature-gated Reticulum adapter in `atomic_lib`.

Likely module shape:

```text
lib/src/sync/reticulum.rs
```

Feature flag:

```text
reticulum
```

Responsibilities:

- start or attach to a Reticulum node
- keep a stable Reticulum identity if the library requires one
- announce availability for selected drive DIDs
- resolve peers for a drive DID
- open a bidirectional session to a peer
- read and write Atomic v2 frames
- expose the same session operations as Iroh/WS transport

The adapter should not parse or apply resources itself. It should hand frames to
the same sync engine used by WS and Iroh.

## Identity Model

Atomic already has Ed25519 Agent keys. Reticulum also uses Ed25519, but a
Reticulum Identity is not the same object:

- Atomic Agent: application/user authority. Signs commits and auth challenges.
- Reticulum Identity: transport reachability identity. Creates destinations,
  proves packet/link delivery, and participates in Reticulum encryption/routing.

Reticulum identities include both signing and encryption material. Current
Reticulum docs describe identities as a 512-bit keyset: X25519 encryption key
plus Ed25519 signing key. Atomic agents only have Ed25519 signing keys.

Do not directly reuse Atomic Agent private keys as Reticulum Identity keys in
the first implementation.

Reasons:

- it would mix application authority with transport reachability
- it could make user identity visible at the routing layer
- it would require adding or deriving X25519 material from an Atomic key
- cross-protocol key reuse complicates security review
- Reticulum node keys may need different rotation and storage policy than
  Atomic agent keys

Recommended model:

1. Each Atomic node has a persisted Reticulum Identity, analogous to the current
   Iroh node secret.
2. Each Atomic user/app keeps its existing Atomic Agent key.
3. Every Reticulum session still performs Atomic `AUTH` using the Atomic Agent.
4. Optional: the node can publish an Atomic-signed binding saying:

   ```text
   agent did:ad:agent:... authorizes reticulum destination <hash>
   for drive did:ad:...
   capabilities: sync, blob-metadata, blob-bytes?
   expires: timestamp
   ```

This binding is useful for UX and peer pinning, but it is not a replacement for
per-session `AUTH` or rights checks.

Privacy rule: announces should not expose the raw Atomic Agent DID by default.
For private drives, prefer a drive discovery hash or encrypted/pairing-only
discovery, then reveal the agent only after link establishment and `AUTH`.

## Frame Strategy

Preferred strategy: carry `lib/src/sync/protocol.rs` frames unchanged over a
Reticulum Link, Channel, or Resource transfer.

This keeps Reticulum integration small and makes tests reusable:

- `AUTH`
- `AUTH_OK`
- `ERROR`
- `GET`
- `UPDATE`
- `DESTROY`
- `COMMIT`
- `COMMIT_OK`
- `SUB`
- `UNSUB`
- `SYNC`
- `SYNC_DIFF`
- `SYNC_PUSH`
- `BLOB_REQUEST`
- `BLOB_RESPONSE`
- `EPHEMERAL`

Do not use bare Reticulum Packets for normal Atomic sync frames. The Reticulum
Packet API is for small payloads; current Reticulum docs list a very small
encrypted packet payload limit. Atomic `SYNC_PUSH`, `UPDATE`, `COMMIT`, and blob
frames routinely exceed that.

Transport choice:

- Use a Reticulum Link for session setup and bidirectional encrypted
  connectivity.
- Use a Reticulum Channel if its per-message MDU is sufficient for small Atomic
  frames.
- Use Reticulum Resource transfers or a small Atomic-over-Link fragmentation
  layer for larger frames such as `SYNC_PUSH` and `BLOB_RESPONSE`.
- Retain Atomic frame boundaries above this layer so the sync engine remains
  transport-neutral.

If it only exposes packet-style messages or small payloads, add a Reticulum-only
fragmentation layer below Atomic frames. Do not change the Atomic frame format
unless Reticulum proves it cannot carry it.

## Bandwidth Profile

Reticulum links may be much slower than WebSocket or Iroh. The transport must be
able to choose conservative behavior.

Defaults for low-bandwidth links:

- prefer `SYNC_DIFF` / `SYNC_PUSH` over polling
- keep `SYNC_PUSH` chunk sizes configurable below the current 1 MiB limit
- avoid automatic blob transfer unless requested
- allow metadata-only sync mode for File resources
- debounce live `UPDATE` pushes aggressively
- do not send collaborative ephemeral cursor traffic unless explicitly enabled

This pairs with `planning/sign-at-drain.md`: fewer signed envelopes and larger
drain boundaries are better for low-bandwidth Reticulum links.

## Authentication and Authorization

Reticulum does not replace Atomic auth.

Reticulum gives the session useful transport properties:

- encrypted delivery to a destination
- link establishment with destination proof
- optional delivery receipts / proofs
- route discovery over non-IP media

Atomic still decides whether the authenticated application agent can read or
write the requested drive/resource.

Required session flow:

1. Open Reticulum route/session.
2. Send Atomic `AUTH` for the requested drive or resource.
3. Receiver verifies the Atomic agent signature.
4. Bind the authenticated agent and requested subject to the session.
5. Only then accept `SYNC`, `SYNC_PUSH`, `COMMIT`, `GET`, or `SUB`.

Policies:

- unauthenticated `SYNC` must fail closed
- Reticulum destination identity is not write permission
- Reticulum path discovery is not read permission
- a Reticulum Identity may be pinned as a known node, but not treated as an
  Atomic Agent unless it presents a valid Atomic-signed binding
- mesh replicas must pass the same commit and rights checks as other transports
- cross-agent sharing should follow `planning/authorization-sync.md`

This mirrors Iroh: the transport node ID is useful for routing and pairing, but
application trust comes from Atomic agent signatures, commits, and ACLs.

## Blob Transfer

Blob DIDs identify bytes, but the File resource is the authorization boundary.

Reticulum blob support should start conservative:

- sync File metadata first
- request blob bytes only after the receiver has read access to the File resource
- support small blobs over Reticulum initially
- for large blobs, allow policy to skip, defer, or require user confirmation

`BLOB_REQUEST` and `BLOB_RESPONSE` should remain the frame-level API.

## Configuration

Add node-level config, not resource-level hacks.

Possible config:

```toml
[reticulum]
enabled = true
instance = "default"
announce_drives = ["did:ad:..."]
allow_blob_transfer = false
max_frame_bytes = 65536
ephemeral = false
```

Questions:

- Does Reticulum RS run an embedded stack, connect to an existing daemon, or
  support both?
- Where should Reticulum identity keys live in `Db`?
- Should browser builds ever support this, or is it native-only?

## Sync Settings UI

Reticulum settings belong on the existing Sync page
(`browser/data-browser/src/routes/SyncRoute.tsx`). That page already owns the
mental model for:

- current drive
- remote server
- local node identity
- known peers
- manual peer sync
- local database
- sync diagnostics
- commit log

Add a Reticulum / Mesh Sync section there instead of creating a separate
settings page.

### User-facing controls

Default, non-advanced controls:

- **Enable mesh sync**: starts/stops the local Reticulum transport.
- **This mesh node**: shows the local Reticulum destination hash or Atomic node
  DID-style wrapper, with copy button.
- **Announce this drive**: whether this device advertises the current drive over
  Reticulum.
- **Discover peers for this drive**: scans known announces for the current drive.
- **Known mesh peers**: list of discovered/pinned peers with last seen, last
  sync, and sync action.
- **Blob sync**: off / ask / on. Default off or ask for constrained links.
- **Connection profile**: normal / low bandwidth. Low bandwidth disables
  ephemeral traffic and uses smaller transfer chunks.

Advanced controls can live behind a disclosure:

- Reticulum config path or daemon endpoint.
- Destination naming mode: node-level announce vs per-drive announce.
- Max frame/resource chunk size.
- Announce interval.
- Whether to include drive hints in public announce `app_data`.
- Export/import Reticulum identity backup.
- Reset Reticulum identity.

### Status surface

The UI should show transport status without exposing protocol internals by
default:

- Disabled
- Starting
- Listening
- Announced
- Discovering
- Syncing
- Error

Useful diagnostics:

- Reticulum destination hash
- known interface count, if available
- last announce timestamp
- last discovered peer timestamp
- last Reticulum sync result
- transport error message

### Privacy defaults

Private data should not leak through announces.

Defaults:

- Reticulum disabled until the user enables it.
- Do not announce every drive automatically.
- Do not expose raw Atomic Agent DID in Reticulum announce data.
- For private drives, prefer compact drive discovery hashes or pairing-only
  discovery.
- Blob bytes require explicit opt-in or confirmation.

### Peer UX

The existing Iroh peer input expects `did:ad:node:<node-id>`. Reticulum should
not overload that format unless we define a generic node DID that can carry
multiple transports.

Options:

- Add a Reticulum-specific input such as `rns:<destination-hash>`.
- Add a transport-neutral peer card that can contain:
  - Iroh node ID
  - Reticulum destination hash
  - Atomic-signed binding
  - label
  - supported capabilities

Longer term, the Sync page should show "Peers" as transport-neutral entries and
let each peer expose available transports.

## Status and Control API

The Sync page cannot inspect Reticulum directly in the browser. For the first
implementation, atomic-server or the native runtime owns Reticulum lifecycle and
exposes a small local API, similar to the current `/iroh-node-id` and
`/iroh-sync` routes.

These routes are a pragmatic bridge, not the final architecture.

Initial HTTP endpoints:

```text
GET   /reticulum/status
POST  /reticulum/enable
POST  /reticulum/disable
PATCH /reticulum/settings
POST  /reticulum/announce
POST  /reticulum/discover
POST  /reticulum/sync
```

Example status payload:

```json
{
  "enabled": true,
  "state": "listening",
  "destination": "rns:abcd...",
  "interfaces": 2,
  "announcedDrives": ["did:ad:..."],
  "knownPeers": [
    {
      "destination": "rns:...",
      "label": "home node",
      "lastSeen": 1779990000000,
      "lastSync": 1779990020000,
      "capabilities": ["sync", "blob-metadata"]
    }
  ],
  "profile": "low-bandwidth",
  "blobSync": "ask",
  "error": null
}
```

Status states:

- `disabled`
- `starting`
- `listening`
- `announced`
- `discovering`
- `syncing`
- `error`

Endpoint responsibilities:

- `/reticulum/status`: return UI-ready transport state.
- `/reticulum/enable`: start or attach to Reticulum and load identity.
- `/reticulum/disable`: stop announcing and close active sessions.
- `/reticulum/settings`: update profile, blob sync, chunk size, announce mode,
  and daemon/config path.
- `/reticulum/announce`: announce one drive or all configured drives.
- `/reticulum/discover`: discover peers for a drive.
- `/reticulum/sync`: run a sync session with a selected peer and drive.

Longer term, replace route-specific UI fetches with the transport-neutral node
API from `planning/atomic-lib-runtime.md`:

```rust
AtomicNode::transport_status()
NodeEvent::TransportChanged { transport: Reticulum, status }
AtomicNode::set_transport_config(...)
AtomicNode::sync_with_peer(...)
```

The browser Sync page should eventually subscribe to Store / AtomicNode status
instead of polling Reticulum-specific endpoints.

## Implementation Plan

- [ ] Audit Reticulum RS APIs and choose whether Atomic embeds it or talks to a
      local Reticulum daemon.
- [ ] Add `reticulum` feature flag to `atomic_lib`.
- [ ] Define or finish the shared `AtomicTransport` trait needed by WS, Iroh,
      and Reticulum.
- [ ] Add a skeleton `sync::reticulum` module with start/stop lifecycle.
- [ ] Implement Reticulum Identity persistence in `Db`, separate from Atomic
      Agent keys.
- [ ] Define the Atomic Reticulum destination/aspect naming scheme.
- [ ] Implement compact drive availability `app_data` and tests.
- [ ] Implement Reticulum announce and resolve for Atomic sync destinations.
- [ ] Optionally implement Atomic-signed Reticulum destination bindings for
      known-node UX and peer pinning.
- [ ] Implement bidirectional frame send/receive.
- [ ] Add Reticulum status to the node/store sync status model.
- [ ] Add initial atomic-server/native status and control endpoints:
      - `GET /reticulum/status`
      - `POST /reticulum/enable`
      - `POST /reticulum/disable`
      - `PATCH /reticulum/settings`
      - `POST /reticulum/announce`
      - `POST /reticulum/discover`
      - `POST /reticulum/sync`
- [ ] Add Sync page UI:
      - enable/disable mesh sync
      - local Reticulum destination display
      - announce current drive toggle
      - discover peers action
      - mesh peers list
      - blob sync preference
      - low-bandwidth profile
- [ ] Run the existing sync engine tests through an in-memory or loopback
      Reticulum transport if the library supports it.
- [ ] Add a two-node integration test:
      - node A has a drive and resource
      - node B resolves A over Reticulum
      - B authenticates
      - B runs `SYNC`
      - B receives `SYNC_PUSH`
      - B can request a blob when authorized
- [ ] Add fail-closed auth tests:
      - unauthenticated `SYNC` receives no private data
      - authenticated agent without read rights receives no private data
      - unauthenticated `SYNC_PUSH` is rejected
- [ ] Add CLI/server config for enabling Reticulum.
- [ ] Document the setup in public docs after the integration test is stable.

## Non-goals for First Pass

- Replacing WebSocket sync.
- Replacing Iroh immediately.
- Making Reticulum destination identity an Atomic identity.
- Full browser support.
- High-throughput blob mirroring over low-bandwidth links.
- Reticulum-specific resource semantics.

## Open Questions

- Is Reticulum RS mature enough to embed directly, or should Atomic first target
  a local Reticulum daemon bridge?
- What Reticulum app/destination naming scheme avoids collisions while keeping
  the DID-derived routing model?
- Do we need transport-level encryption beyond Reticulum's own link/session
  model, or is Atomic commit/auth evidence sufficient at the application layer?
- Should Reticulum peers announce per drive, per agent, or per node?
- How should users express "sync this drive over Reticulum but not blobs"?
- What are sane default chunk sizes for LoRa-class links?
