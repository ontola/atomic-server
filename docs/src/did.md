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

Atomic Data defines the `did:ad` method with three forms, distinguished by an explicit type prefix:

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
did:ad:commit:{signature}?drive={drive_hash}
```

### Resource identifiers

Resources live inside [Drives](hierarchy.md).
The **Core Identity** of a resource is mathematically pure—it is simply the signature of its first commit (the genesis commit):

```text
did:ad:{genesis}
```

However, to discover this resource over a decentralized network, a client needs to know *which* Drive theoretically hosts it. This is done by appending a standard W3C DID query parameter containing the Drive's destination hash as a routing hint:

```text
did:ad:{genesis}?drive={drive_hash}
```

For example:

```text
did:ad:4f7ba2...910?drive=4faf1b2e0a077e6a9d92fa051f256038
```

### Drive identity and hashes

A Drive is identified by a **destination hash**. This hash is derived from the Drive's cryptographic public key (Ed25519).

The formula for the hash is:
```text
drive_hash = truncated_SHA256("atomicdata.drive" || drive_public_key)
           = 16 bytes (128 bits)
```

This ensures:
- **Portability**: The identifier depends only on the Drive's key, not its location.
- **Reticulum Compatibility**: This hash is a valid Reticulum destination.
- **Multi-tenancy**: A single server/node can host multiple Drives, each with its own key and hash.

The Drive's public key is stored as a property on the Drive resource itself. This allows any node replicating the Drive to compute the same hash, ensuring the Drive is discoverable under the same `did:ad` identifier globally.

### Drive replication

A core principle is that **any node can replicate a Drive without holding the Drive's private key**.
Trust comes from [Commit signatures](commits/intro.md), not from who serves the data:

1. The Drive owner creates resources and signs [Commits](commits/intro.md) with their Agent key.
2. A replica node syncs the data and verifies every Commit signature.
3. The replica announces itself as a peer for this Drive (on Mainline DHT, Reticulum, or both) using the Drive's hash.
4. Clients fetching data verify Commit signatures themselves — they don't need to trust the serving node.

## Resolution

Resolving a `did:ad` URL means finding a network node that holds the requested Drive and resource.
Multiple resolution strategies can be tried in order:

### 1. Local cache

If the resource has been fetched before, serve it from the local store.

### 2. Reticulum mesh resolution

[Reticulum](https://reticulum.network/) is a mesh networking stack that works over any medium — radio, LoRa, serial, TCP, UDP, and more.
Its addressing model is a natural fit for `did:ad`:

- Reticulum destinations are 16-byte hashes — the same format as Drive hashes.
- The Drive hash _is_ a valid Reticulum destination, so mesh resolution requires no translation.
- To reach a Drive on a Reticulum mesh, a client sends a **path request** for the destination hash. Any Transport Node that has seen an announce for that destination can route the request.
- The Drive node (or any replica) announces its destination on the mesh, making it reachable within minutes even on slow, multi-hop networks.

This means two Atomic Server nodes on a Reticulum mesh (e.g. over LoRa radio) can exchange and resolve resources **without any internet access**, using the exact same `did:ad` identifiers they would use online.

Reticulum uses the same cryptographic primitives as Atomic Data:

- Ed25519 for signatures
- X25519 for key exchange
- SHA-256 for hashing

### 3. Mainline DHT (internet)

[Mainline DHT](https://en.wikipedia.org/wiki/Mainline_DHT) is the BitTorrent distributed hash table — a decentralized network with millions of active nodes.
It provides a way for any node to announce that it hosts a given Drive, and for clients to discover those nodes:

1. A node hosting a Drive calls `announce_peer(SHA1(drive_hash))` on the Mainline DHT.
2. A client resolving a Drive calls `get_peers(SHA1(drive_hash))` and receives a list of IP:port pairs.
3. The client connects to any discovered peer and requests the resource.
4. Commit signatures are verified client-side.

No special signing keys (BEP44) are needed at the DHT layer.
The DHT is a pure _discovery_ mechanism — all trust and authenticity comes from the Commit signatures in the data itself.
Any node — the original or a replica — can announce itself as a peer.

### 4. Direct connection

If the node's IP or domain is already known (e.g. from configuration or a previous session), connect directly.

## Relationship to the internal `Subject` type

Internally, AtomicServer uses the [`Subject`](https://github.com/atomicdata-dev/atomic-server/blob/main/lib/src/subject.rs) enum to represent resource identifiers.
The three variants map to different resolution strategies:

| `Subject` variant | Format | Use case |
|---|---|---|
| `Internal` | `internal:/path` | Local resources on this server. Resolved to an absolute URL using the server's origin for serialization. |
| `Did` | `did:ad:...` | Agents (by public key), Commits (by signature), and resources in Drives (by genesis commit signature). Routing happens via `?drive=` hints. Resolved via Reticulum or Mainline DHT. |
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

The main distinction of `did:ad` is that it separates mathematically pure identity (`did:ad:{genesis}`) from network discovery routing hints (`?drive={hash}`).
Combined with Atomic Data's Commit-based trust model, this enables multi-node replication where any peer can serve verified data seamlessly.
