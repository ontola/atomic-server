{{#title Permissions and identity during Atomic Sync}}
# Permissions and identity during sync

Syncing your data to other machines should never mean handing it to everyone who can reach those machines.
So syncing does not bypass access control. Every node that receives data decides for itself what it accepts and what it sends, using the same rules on every transport.

## Who you are: Agents and signatures

An [Agent](../agents.md) is an Ed25519 key pair, identified by its public key (`atomic:agent:<publicKey>`).
There's no account to sign up for: you prove who you are by signing.
Two things are signed during sync:

- **Connection proof (`AUTH`).** When a link opens, the client sends its Agent, its public key, a timestamp and a signature over `"{requestedSubject} {timestamp}"`. The proof is rejected if the timestamp is more than five minutes old, or if `requestedSubject` does not name the node being asked. For a WebSocket, that is the server's origin, plus a one-time challenge nonce that the server sends first. For Iroh, it is the Drive about to be synced. A proof for one place cannot be replayed at another. See [Authentication](../websockets.md#authentication).
- **Every change (Commit).** A [Commit](../commits/intro.md) is signed by the Agent that made it. The receiver verifies the signature and then checks that the signer may write the Resource. A change is not trusted because of the connection it arrived on, or because of the node that relayed it.

Before `AUTH` succeeds, a session is the public Agent. On an Iroh stream nothing but `AUTH` is accepted before then. Over a WebSocket an anonymous session may still read what is public, which is what makes shared links work, but it cannot send a `SYNC_PUSH`.

## What you may see and change: rights

Rights come from the [hierarchy](../hierarchy.md): `read` and `write` lists on a Resource or on any of its parents, which add up down the tree. [Invitations](../invitations.md) and sharing add Agents to those lists.

The receiving node applies them at every step:

- **Sending.** A `SYNC` is answered with the Resources the asking Agent may read, and nothing else. The Drive hash used by the probe is computed over the same set, so a client only ever compares against what it is allowed to hold.
- **Receiving.** A `SYNC_PUSH` is accepted only from a sender who has write rights on the Drive. If the whole push is refused, nothing from it is applied and the sender gets an error. Individual commits are checked against the signer's write right on the Resource.
- **Deleting.** A delete counts only as a signed destroy commit from someone who may delete.
- **Files.** The bytes of a file are fetched by their content hash. Knowing the hash is the capability, and the hash is only learnable from a Resource you were allowed to read.

## Pairing introduces, it does not authorize

Scanning a QR code or opening a peer link tells a device where to connect. A node id is a _route_, not a credential, and the peer still has to prove an Agent.
So "I paired my phone" is not the same as "my phone can see everything".
A peer you paired with deliberately is served whatever your node may read, never more.
Dialing a peer also does not give that peer any rights on your node. To give another person access, [share](../invitations.md) the Drive with their Agent.

## Servers and admission

A server is held to the same checks. It can't make up changes in your name, because it has no key to sign them.
A node can also limit which Drives it accepts at all. By default a node accepts new Drives from any Agent that passes the checks above. An operator can restrict that, for example to one owner. See [Putting your server on the internet](../atomicserver/installation.md#putting-your-server-on-the-internet).

## Limits to be aware of

- Raw state sent in a `SYNC_PUSH` between peers is imported from a sender who has write rights. A signed envelope can travel with it so the receiver can attribute history, but you should pair only with Agents you trust with the Drive.
- Anyone with a valid signed change can send it through any node. That is by design: authority comes from the signature, not from the route.
- The [wire protocol page](../websockets.md#known-gaps) lists the known gaps, such as the optional challenge nonce.
