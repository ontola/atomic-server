{{#title Decentralized Identifiers (DIDs) in Atomic Data }}
# Decentralized Identifiers

_status: work in progress_

Atomic Data is moving from HTTP URLs to Decentralized Identifiers (DIDs) as the primary way to address resources.
This makes resources portable, self-authenticating, and resolvable over both the internet and local mesh networks.

## Design goals

- **Self-sovereign**: Identifiers don't depend on any server or domain name. You generate a keypair, and you have an identity.
- **Portable**: Resources can move between servers without changing their identifier.
- **Multi-transport**: The same identifier can be resolved over the internet (Mainline DHT) or local mesh networks (Reticulum).
- **Verifiable**: Trust comes from [Commit](commits/intro.md) signatures, not from who hosts the data.
- **Replicatable**: Any node can replicate and serve a Drive without holding the Drive's private key.

## The `did:ad` method

Atomic Data defines the `did:ad` method with four forms, distinguished by an explicit type prefix (or its absence, for Resources):

### Agent identifiers

[Agents](agents.md) are identified by the `agent` prefix followed by their public key:

```text
did:ad:agent:{publicKey}
```

The `publicKey` is an Ed25519 public key, base64-encoded.
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
More sophisticated resolution (e.g. using [Mainline DHT](#3-mainline-dht-internet) or [Reticulum](#2-reticulum-mesh-resolution) announces) can be layered on later without changing the DID format.

### Commit identifiers

[Commits](commits/intro.md) are the fundamental events in Atomic Data. They are identified by the `commit` prefix followed by their cryptographic signature:

```text
did:ad:commit:{signature}
```

The `signature` is the base64-encoded Ed25519 signature of the commit.
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

A client looks up peers for the Drive via Mainline DHT or Reticulum, then asks any of them for the blob. Over the v2 sync protocol, blobs travel as raw 32-byte hashes inside `BLOB_REQUEST`/`BLOB_RESPONSE` frames — the DID is for *identity*, the bytes on the wire are the underlying hash. (This parallels commits: the DID is `did:ad:commit:{sig}`, but the wire never re-prepends the prefix.)

The HTTP form `<origin>/download/files/{blake3}` is a deployment-specific alias for `did:ad:blob:{blake3}` and remains supported for browsers and existing tooling.

### Resource identifiers

Resources live inside [Drives](hierarchy.md).
The **Core Identity** of a resource is mathematically pure—it is simply the signature of its first commit (the genesis commit):

```text
did:ad:{genesis}
```

#### Genesis commit signing

A genesis commit is a regular commit with `isGenesis: true` and no `previousCommit`.
When signing, the `subject` field is **excluded** from the canonical bytes because the subject is the signature itself (a circular dependency).
All other fields — including `isGenesis` — are part of the signed bytes.
The server verifies this by applying the same exclusion before checking the signature.

This means the subject is derived post-signing as `did:ad:{signature}`, and `isGenesis: true` must be explicitly present in the commit sent to the server so that it can reconstruct the correct canonical bytes for verification.

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

When a Drive is used as a routing hint (the `?drive=` parameter), network nodes derive an **internal discovery hash** for lookups on decentralized networks (Mainline DHT or Reticulum). This hash is never stored as an explicit property; it is derived on-the-fly when needed for discovery.

The formula for the discovery hash is:
```text
discovery_hash = HASH(drive_did_string)
```

The specific hash algorithm depends on the transport protocol:
- **Mainline DHT**: Uses `SHA1(drive_did_string)` to produce a 20-byte ID.
- **Reticulum**: Uses `truncated_SHA256(drive_did_string)` to produce a 16-byte destination.

This ensures:
- **Consistency**: Everything is a `did:ad` identifier.
- **Portability**: The identifier depends only on the Drive's genesis state, not its location.
- **Protocol Independence**: The same DID can be mapped to different binary formats required by different networks.

### Drive replication

A core principle is that **any node can replicate a Drive without holding the Drive's private key**.
Trust comes from [Commit signatures](commits/intro.md), not from who serves the data:

1. The Drive owner creates resources and signs [Commits](commits/intro.md) with their Agent key.
2. A replica node syncs the data and verifies every Commit signature.
3. The replica announces itself as a peer for this Drive (on Mainline DHT, Reticulum, or both) using the discovery hash derived from the Drive's DID string.
4. Clients fetching data derive the same hash from the `?drive=` hint and look up peers.
5. Clients fetch data and verify Commit signatures themselves — they don't need to trust the serving node.

## Resolution

Resolving a `did:ad` URL means finding a network node that holds the requested Drive and resource.
Multiple resolution strategies can be tried in order:

### 1. Local cache

If the resource has been fetched before, serve it from the local store.

### 2. Reticulum mesh resolution

[Reticulum](https://reticulum.network/) is a mesh networking stack that works over any medium — radio, LoRa, serial, TCP, UDP, and more.
Its addressing model is a natural fit for `did:ad`:

- Reticulum destinations are 16-byte hashes.
- To reach a Drive on a Reticulum mesh, a client sends a **path request** for the 16-byte destination derived from the Drive's DID string. Any Transport Node that has seen an announce for that destination can route the request.
- The Drive node (or any replica) announces its destination on the mesh, making it reachable within minutes even on slow, multi-hop networks.

This means two Atomic Server nodes on a Reticulum mesh (e.g. over LoRa radio) can exchange and resolve resources **without any internet access**, using the exact same `did:ad` identifiers they would use online.

### 3. Mainline DHT (internet)

[Mainline DHT](https://en.wikipedia.org/wiki/Mainline_DHT) is the BitTorrent distributed hash table — a decentralized network with millions of active nodes.
It provides a way for any node to announce that it hosts a given Drive, and for clients to discover those nodes:

1. A node hosting a Drive calls `announce_peer(SHA1(drive_did_string))` on the Mainline DHT.
2. A client resolving a Drive calls `get_peers(SHA1(drive_did_string))` and receives a list of IP:port pairs.
3. The client connects to any discovered peer and requests the resource using the original DID.
4. Commit signatures are verified client-side.

No special signing keys (BEP44) are needed at the DHT layer.
The DHT is a pure _discovery_ mechanism — all trust and authenticity comes from the Commit signatures in the data itself.
Any node — the original or a replica — can announce itself as a peer.

### 4. Direct connection

If the node's IP or domain is already known (e.g. from configuration or a previous session), connect directly.

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
| `Did` | `did:ad:...` | Agents (by public key), Commits (by signature), Blobs (by BLAKE3 hash), and Resources in Drives (by genesis commit signature). Routing hints (`?drive=did:ad:...`) are used for peer discovery via Reticulum or Mainline DHT. |
| `External` | `https://...` | Resources on other servers. Resolved via HTTP. Used for backward compatibility and external linked data. |

When serializing to [JSON-AD](core/json-ad.md), `Internal` subjects are resolved to absolute URLs using the server's configured origin.
`Did` subjects are serialized as-is — they are already globally unique and location-independent.

## Comparison with other DID methods

| | `did:ad` | `did:web` | `did:dht` | `did:key` |
|---|---|---|---|---|
| **Decentralized** | ✅ No server dependency | ❌  Depends on DNS | ✅ Mainline DHT | ✅ Self-contained |
| **Mesh-capable** | ✅ Native Reticulum | ❌ | ❌ | ✅ But no routing |
| **Updatable** | ✅ Drive can move | ✅ Update DNS | ✅ Mutable records | ❌ Static |
| **Replicatable** | ✅ Any node can serve | ❌ Single server | ❌ Key holder only | N/A |
| **Trust model** | Commit signatures | TLS + DNS | BEP44 signatures | Key-based |
| **Resources** | ✅ Granular via `genesis` | ❌ One doc per DID | ❌ One doc per DID | ❌ One key per DID |

The main distinction of `did:ad` is that it separates mathematically pure identity (`did:ad:{genesis}`) from network discovery routing hints (`?drive=did:ad:{drive_genesis}`).
Combined with Atomic Data's Commit-based trust model, this enables multi-node replication where any peer can serve verified data seamlessly.

## Path Restrictions
Unlike `http(s):` or `internal:` identifiers which are highly hierarchical, `did:ad:` identifiers **do not support sub-paths** (e.g. `did:ad:123/my-property`).
Every individual resource within a DID hierarchy must be explicitly created with its own standalone genesis commit, leading to a flat namespace of `did:ad:<hash>` identifiers that relate to each other through the `parent` property, rather than structurally via paths.
