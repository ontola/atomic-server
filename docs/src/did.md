{{#title Decentralized Identifiers (DIDs) in Atomic Data }}
# Decentralized Identifiers

_Identity forms below are stable and used in production. Discovery transports keep evolving — see [Resolution](#resolution)._

Atomic Data uses Decentralized Identifiers (DIDs) as the primary way to address resources.
This makes resources portable, self-authenticating, and resolvable without tying identity to a hostname.

## Design goals

- **Self-sovereign**: Identifiers don't depend on any server or domain name. You generate a keypair, and you have an identity.
- **Portable**: Resources can move between servers without changing their identifier.
- **Multi-transport**: The same identifier can be discovered and synced over WebSocket, Iroh (QUIC), and (planned) mesh stacks such as Reticulum.
- **Verifiable**: Trust comes from [Commit](commits/intro.md) signatures, not from who hosts the data.
- **Replicatable**: Any node can replicate and serve a Drive without holding the Drive's private key.

## The `did:ad` method

Atomic Data defines the `did:ad` method with five forms, distinguished by an explicit type prefix (or its absence, for Resources):

### Encoding

All binary parts of a `did:ad` identifier — public keys and signatures — are encoded with **URL-safe, unpadded base64** (RFC 4648 §5: alphabet `A–Z a–z 0–9 - _`, no `=` padding). Blob hashes are the exception: they are hex (see [Blob identifiers](#blob-identifiers)).

This matters because identifiers travel inside URLs (`/app/show?subject=did:ad:…`, the `?drive=` routing hint, deep links). The *standard* base64 alphabet contains `+` and `/`: a `+` is turned into a space by form-decoders (`application/x-www-form-urlencoded`), and `/` and the `=` padding are path/query-significant — any of them silently corrupts a subject on a URL round-trip. The URL-safe alphabet avoids all three, so a `did:ad:` subject can be dropped into a URL verbatim and survive parsing.

Decoders accept the legacy standard alphabet (`+` `/`, padded) as well, so data written before this convention still resolves.

### Node identifiers

Atomic nodes are identified by the `node` prefix followed by the transport's
stable node identifier:

```text
did:ad:node:{nodeId}
```

`did:ad:node:` is the canonical user-facing and HTTP API form. A transport may
use a raw binary or hex value internally (for example, Iroh's `NodeId`), but
that transport-specific representation is not an alternative public
identifier.

A Node DID identifies a replication endpoint for discovery and routing. It is
**not a Resource**, does not have Atomic properties or commit history, and does
not grant read or write authority. Transport authentication can prove which
node is connected; authorization still comes from Agent identities, grants,
and signed mutations.

### Agent identifiers

[Agents](agents.md) are identified by the `agent` prefix followed by their public key:

```text
did:ad:agent:{publicKey}
```

The `publicKey` is an Ed25519 public key, [URL-safe base64-encoded](#encoding).
The `agent` prefix disambiguates agents from drive resources and signals that the identifier is primarily a verification key.

Agents are **not scoped to any Drive**.
An agent identity is independent — you generate a keypair and immediately have a globally unique, self-sovereign identity.
This avoids tying an agent to a specific server, avoids chicken-and-egg problems (agents create drives, so they must exist first), and keeps the identity stable even if the agent's home server changes.

#### Agent resolution

For most operations, agents don't need to be "resolved" at all:

- **Verifying a commit**: The public key is embedded in the DID itself. No network call needed.
- **Granting permissions**: The DID is all you need to reference an agent in `read`/`write` lists.
- **Displaying profile info** (name, avatar): Drives cache agent metadata when agents interact with them (e.g. accepting an [Invite](invitations.md), making a [Commit](commits/intro.md)). The drive you're connected to typically already has it.

If a client encounters an unknown agent, it can show the truncated public key as a fallback.
Peer discovery for the drives an agent touches uses [pkarr](#3-pkarr--iroh-internet) (and can grow additional transports later) without changing the DID format.

### Commit identifiers

[Commits](commits/intro.md) are the fundamental events in Atomic Data. They are identified by the `commit` prefix followed by their cryptographic signature:

```text
did:ad:commit:{signature}
```

The `signature` is the [URL-safe base64-encoded](#encoding) Ed25519 signature of the commit.
Using a DID for commits ensures that the history of a resource is fully portable and not tied to the server where the commit was originally created.

Like resources, commits can include a routing hint to help discover them over decentralized networks:

```text
did:ad:commit:{signature}?drive=did:ad:{drive_genesis}
```

### Blob identifiers

Binary file contents (the bytes behind a [File](files.md) resource) are identified by the `blob` prefix followed by the BLAKE3 hash of the bytes:

```text
did:ad:blob:{blake3}
```

The `blake3` is a 32-byte BLAKE3 hash, hex-encoded (64 characters). Hex rather than base64 because BLAKE3 tooling consumes and produces hex by convention, and because a content hash is conceptually a different thing from a key or signature.

Blobs are **not Resources**. They have no parent, no class, no ACL, no commit history — they are raw, content-addressed bytes. The File resource that *describes* a blob is a normal Resource and carries all the metadata (filename, mimetype, parent for permissions); it points at its blob via a `blob` property whose value is a `did:ad:blob:` reference.

#### Capability semantics

Knowing a `did:ad:blob:` identifier is, by itself, the capability to retrieve the bytes — there is no second authorization check inside the blob store. This works because:

- A 256-bit BLAKE3 hash is unforgeable: you cannot guess one.
- The only ways to obtain it are to already have the bytes (and compute it yourself), or to read a Resource that references it.
- Reading that Resource passes through the normal [hierarchy](hierarchy.md) authorization. That is where access control lives — the bytes simply follow.

So the auth boundary is the **File resource**, not the blob. This is the same model used by Git objects, IPFS CIDs, S3 presigned URLs, and Iroh tickets. Treat a leaked blob DID the same as a leaked file.

#### Resolution and routing

Like resources and commits, blob DIDs accept a routing hint pointing at a Drive that is expected to hold the bytes:

```text
did:ad:blob:{blake3}?drive=did:ad:{drive_genesis}
```

A client looks up peers for the Drive (pkarr / known peers / configured server), then asks any of them for the blob. Over the v2 sync protocol, blobs travel as raw 32-byte hashes inside `BLOB_REQUEST`/`BLOB_RESPONSE` frames — the DID is for *identity*, the bytes on the wire are the underlying hash. (This parallels commits: the DID is `did:ad:commit:{sig}`, but the wire never re-prepends the prefix.)

The HTTP form `<origin>/download/files/{blake3}` is a deployment-specific alias for `did:ad:blob:{blake3}` and remains supported for browsers and existing tooling.

### Resource identifiers

Resources live inside [Drives](hierarchy.md).
The **Core Identity** of a resource is derived from its **Self-Verifying Genesis Certificate**:

```text
did:ad:{genesis}
```

#### Genesis Certificate Derivation (v2)

To ensure authorship and identity are verifiable offline without fetching previous commits, a new DID resource carries its own inline, binary **Genesis Certificate** (`GenesisCert`), stored as an immutable property `genesis` (`https://atomicdata.dev/properties/genesis`) on the resource.

The `did:ad:{genesis}` subject is the URL-safe base64-encoded Ed25519 signature over the binary layout of the certificate:
1. `version`: `0x01` (1 byte)
2. `flags`: `u8` (bit0 = has `stateHash`) (1 byte)
3. `signerPubKey`: Ed25519 public key of the creating agent (32 bytes)
4. `createdAt`: UNIX timestamp in milliseconds (8 bytes i64)
5. `nonce`: CSPRNG random unique bytes (16 bytes)
6. `stateHash` (Optional): Blake3 hash of the canonical genesis projection (32 bytes)
7. `parent`: Subject of the parent resource (variable length)
8. `drive`: Subject of the owning drive (variable length)

The DID of the resource is `did:ad:<base64url(signature_of_cert)>`. This enables instant offline verification of authorship, parentage, and drive membership from the resource payload alone.

#### Legacy Genesis Commit Derivation (v1)

For backward compatibility (including legacy or browser-minted resources), resources can be derived using the legacy path:
- A genesis commit is signed with `isGenesis: true` and no `previousCommit`.
- The `subject` field is **excluded** from the canonical bytes during signing to prevent a circular dependency.
- The subject is derived as `did:ad:{signature}` of the first commit.

However, to discover this resource over a decentralized network, a client needs to know *which* Drive theoretically hosts it. This is done by appending a standard W3C DID query parameter containing the Drive's DID as a routing hint:

```text
did:ad:{genesis}?drive=did:ad:{drive_genesis}
```

For example:

```text
did:ad:4f7ba2...910?drive=did:ad:7e6a9d...038
```

### Drive identity

A Drive is a first-class resource identified by its own `did:ad` identifier.

When a Drive is used as a routing hint (the `?drive=` parameter), nodes may derive an **internal discovery key** from the Drive's DID string for announce/lookup on a given transport. That key is not stored as a resource property; it is computed when publishing or resolving peers.

What matters for applications:

- **Consistency**: Everything is a `did:ad` identifier.
- **Portability**: The identifier depends only on the Drive's genesis state, not its location.
- **Protocol independence**: The same DID can be mapped to different discovery backends (pkarr today; additional mesh or DHT backends later).

### Drive replication

A core principle is that **any node can replicate a Drive without holding the Drive's private key**.
Trust comes from [Commit signatures](commits/intro.md), not from who serves the data:

1. The Drive owner creates resources and signs [Commits](commits/intro.md) with their Agent key.
2. A replica node syncs the data and verifies every Commit signature.
3. The replica announces itself as a peer for this Drive (pkarr today; additional transports later).
4. Clients discover peers from that announce, a pairing code, or a configured server address.
5. Clients fetch data and verify Commit signatures themselves — they don't need to trust the serving node.

## Resolution

Resolving a `did:ad` URL means finding a network node that holds the requested Drive and resource.
Strategies are tried from local to remote:

### 1. Local cache

If the resource is already in the local store (browser OPFS, device redb, etc.), serve it from there. This is the [local-first](atomicserver/local-first.md) path.

### 2. Direct connection / known peers

If the node's address is already known — Sync settings, a previous session, or a [pairing code](atomicserver/gui/sync-and-pairing.md) — connect over WebSocket or Iroh and fetch or sync the resource.

### 3. pkarr + Iroh (internet)

Production discovery uses **[pkarr](https://pkarr.org/)** to publish and resolve which [Node](#node-identifiers) holds a Drive, then **[Iroh](https://iroh.computer)** (QUIC, with relay fallback) to sync. The flow:

1. A node hosting a Drive publishes its NodeID via pkarr (keyed from the Drive identity).
2. Another device resolves that NodeID, connects over Iroh, and runs the [sync protocol](websockets.md).
3. Commit signatures are verified client-side.

pkarr is a pure _discovery_ mechanism — authenticity still comes only from Commit signatures. Any replica that holds the data can announce itself.

### 4. Reticulum mesh (planned)

[Reticulum](https://reticulum.network/) is a mesh networking stack (radio, LoRa, serial, TCP, and more). Carrying the same sync protocol over Reticulum is a design goal so two nodes could exchange `did:ad` resources without internet access. It is **not** required for current deployments; see the internal `planning/reticulum-sync.md` notes.

## HTTP Discovery

While `did:ad` identifiers are the primary way to address resources, many users still access Atomic Data via standard HTTP URLs (e.g., `https://atomicdata.dev/about`). To bridge the gap between **Location** (the URL) and **Identity** (the DID), Atomic Server includes a `Link` header in its HTTP responses:

```http
Link: <did:ad:{genesis}>; rel="canonical"
```

This header provides several benefits:
- **Portability**: It explicitly signals that the resource has a permanent, location-independent identity.
- **Client Transition**: Sophisticated clients (like the Atomic Data Browser) can see this header and "upgrade" the connection from a specific server URL to a decentralized DID-based resolution.
- **SEO for Data**: Similar to how `rel="canonical"` is used in HTML to prevent duplicate content, it tells the network which identifier is the authoritative "name" for the data, regardless of which server is currently hosting it.

## Relationship to the internal `Subject` type

Internally, AtomicServer uses the [`Subject`](https://github.com/atomicdata-dev/atomic-server/blob/main/lib/src/subject.rs) enum to represent resource identifiers.
The three variants map to different resolution strategies:

| `Subject` variant | Format | Use case |
|---|---|---|
| `Internal` | `internal:/path` | Local resources on this server. Resolved to an absolute URL using the server's origin for serialization. |
| `Did` | `did:ad:...` | Agents (by public key), Commits (by signature), Blobs (by BLAKE3 hash), Nodes (as routing identities), and Resources in Drives (by genesis commit signature). Routing hints (`?drive=did:ad:...`) help peer discovery (pkarr / known peers). |
| `External` | `https://...` | Resources on other servers. Resolved via HTTP. Used for backward compatibility and external linked data. |

When serializing to [JSON-AD](core/json-ad.md), `Internal` subjects are resolved to absolute URLs using the server's configured origin.
`Did` subjects are serialized as-is — they are already globally unique and location-independent.

## Comparison with other DID methods

| | `did:ad` | `did:web` | `did:dht` | `did:key` |
|---|---|---|---|---|
| **Decentralized** | ✅ No server dependency | ❌  Depends on DNS | ✅ Mainline DHT | ✅ Self-contained |
| **Discovery today** | ✅ pkarr + Iroh / WS | DNS | Mainline DHT | N/A |
| **Mesh-capable** | 🚧 Reticulum planned | ❌ | ❌ | ✅ But no routing |
| **Updatable** | ✅ Drive can move | ✅ Update DNS | ✅ Mutable records | ❌ Static |
| **Replicatable** | ✅ Any node can serve | ❌ Single server | ❌ Key holder only | N/A |
| **Trust model** | Commit signatures | TLS + DNS | BEP44 signatures | Key-based |
| **Resources** | ✅ Granular via `genesis` | ❌ One doc per DID | ❌ One doc per DID | ❌ One key per DID |

The main distinction of `did:ad` is that it separates mathematically pure identity (`did:ad:{genesis}`) from network discovery routing hints (`?drive=did:ad:{drive_genesis}`).
Combined with Atomic Data's Commit-based trust model, this enables multi-node replication where any peer can serve verified data seamlessly.

## Path Restrictions
Unlike `http(s):` or `internal:` identifiers which are highly hierarchical, `did:ad:` identifiers **do not support sub-paths** (e.g. `did:ad:123/my-property`).
Every individual resource within a DID hierarchy must be explicitly created with its own standalone genesis commit, leading to a flat namespace of `did:ad:<hash>` identifiers that relate to each other through the `parent` property, rather than structurally via paths.
