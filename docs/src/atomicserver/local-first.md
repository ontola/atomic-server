# Local-first

Atomic Data is **local-first**: you can create and edit data with no server in
reach. A server, when you use one, is an always-on peer you sync with — not the
source of truth.

## What that means in practice

- **Your identity is a keypair.** An [Agent](../agents.md) is identified by
  `did:ad:agent:{publicKey}`. There is no account on a host that can lock you
  out; losing the secret (or its [passkey backup](#encryption-and-recovery)) is
  what loses the identity.
- **Resources have portable addresses.** Subjects use the [`did:ad`](../did.md)
  scheme, so moving data between devices does not rename it.
- **Every write is a signed CRDT commit.** Edits are [Atomic Commits](../commits/intro.md)
  backed by [Loro](https://loro.dev) documents. Concurrent edits merge instead of
  overwriting; history and authorship stay verifiable.
- **The browser runs the real database.** Through WASM, the web app uses the
  same Rust storage and query engine as AtomicServer (`atomic_lib`), persisted in
  the Origin Private File System (OPFS). An offline table computes the same
  totals as an online one because it is the same code.

## Where data lives

| Client | Storage | Notes |
| --- | --- | --- |
| Browser (data-browser) | Per-agent encrypted OPFS database via WASM | Works fully offline; outbox drains commits when a peer is reachable |
| Desktop / mobile (Tauri) | Embedded `atomic_lib` + local files | Can pair with other devices over Iroh |
| Flutter canvas app | `atomic_lib` via flutter_rust_bridge | Same local-first store and peer sync |
| AtomicServer | redb on disk | An always-on device; HTTP/WS plus the same sync protocol |

A browser tab is **not** a peer node by itself: it reads and writes through an
always-on device (your desktop app, a home server, or a hosted instance) when it
needs to reach other machines. Creating a workspace in the browser alone still
works locally; getting it onto a phone requires a device that can pair. See
[Sync & pairing](gui/sync-and-pairing.md).

## Encryption and recovery

Each agent's in-browser database is encrypted at rest (XChaCha20-Poly1305), under
a key wrapped by that agent's private key. Signing out leaves the cache in place
but unreadable to the next session.

Account backup is passkey-first: a WebAuthn passkey wraps a backup of the agent
secret (Argon2id + AES-GCM), so onboarding does not require writing a secret
down. You can still export the agent secret manually from User Settings.

## Syncing

When two devices share rights on a workspace, they converge with the
[sync protocol](../websockets.md):

1. **WebSocket** — browser ↔ always-on device (subscribe, live commits, bulk sync).
2. **Iroh (QUIC)** — device ↔ device after scanning a pairing code.

Discovery of *which* node holds a drive uses pkarr (and Iroh's own relay
discovery). Trust always comes from commit signatures and
[hierarchy](../hierarchy.md) rights — never from who serves the bytes.

## Related

- [`did:ad` identifiers](../did.md)
- [WebSocket / sync protocol](../websockets.md)
- [Sync & pairing (GUI)](gui/sync-and-pairing.md)
- [Commits](../commits/intro.md)
