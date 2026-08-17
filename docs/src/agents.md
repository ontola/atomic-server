{{#title Atomic Data Agents - Users and identities }}
# Atomic Agents

Atomic Agents are used for [authentication](./authentication.md): to set an identity and prove who an actor actually is.
Agents can represent both actual individuals, or machines that interact with data.
Agents are the entities that can get write / read rights.
Agents are used to sign Requests and [Commits](commits/intro.md) and to accept [Invites](invitations.md).

## Design goals

- **Decentralized**: Atomic Agents can be created by anyone, at any domain
- **Easy**: It should be easy to work with, code with, and use
- **Privacy-friendly**: Agents should allow for privacy friendly workflows
- **Verifiable**: Others should be able to verify who did what
- **Secure**: Resistant to attacks by malicious others

## The Agent model

_url: https://atomicdata.dev/classes/Agent_

An Agent is a Resource with its own URL.
When it is created, the one creating the Agent will generate a cryptographic (Ed25519) keypair.
It is _required_ to include the [`publicKey`](https://atomicdata.dev/properties/publicKey) in the Agent resource.
The [`privateKey`](https://atomicdata.dev/properties/privateKey) should be kept secret, and should be safely stored by the creator.
For convenience, a `secret` can be generated, which is a single long string of characters that encodes both the `privateKey` and the `subject` of the Agent.
This `secret` can be used to instantly, easily log in using a single string.

The `publicKey` is used to verify commit signatures by that Agent, to check if that Agent actually did create and sign that Commit.

## Creating an Agent

An Agent is identified by a DID (Decentralized Identifier) derived from its public key: `did:ad:agent:{publicKey}`.
When a client generates a keypair, the public key immediately determines the Agent's subject, without needing to register it on a server first.
See the [DID specification](did.md) for details on how agent DIDs work and are resolved.

One way to start using your Agent is by accepting an [Invite](invitations.md) with your public key.
The server will derive the `did:ad:agent:` identifier and grant the requested rights.
Alternatively, you can host an [Atomic Server](https://crates.io/crates/atomic-server) and use the `/setup` invite to configure the root Agent.

## App keys (issued agents)

An Agent secret is a credential. Your **account** secret should stay on your devices. When an app or plugin needs access — a Raycast extension that should read your workspaces, a CI job, a local script — mint a **new** Agent, grant it only the rights it needs, and give *that* secret to the app.

In the Data Browser this is **User Settings → App keys**:

1. Name the key (e.g. `Raycast`).
2. Choose Read only or Read and write, and which resources it may access — a whole workspace, or a single folder or page. Rights inherit to children, so a folder grant is that folder and everything inside it, not the rest of the workspace.
3. Copy the secret once. It is not stored. If you lose it, revoke the key and create a new one.
4. The signed-in session stays you. The new identity is a separate `did:ad:agent:…`.

Revoking a key removes it from those resources' `read` / `write` lists. The Agent resource stays (old commits still need the public key); it just can no longer read or write what you granted.

This is not the same as the `/app/token` bearer page, which signs in **as you** for a short session. Do not give that to a plugin.

### Requesting rights (for app developers)

Settings is how a person mints a key. An app should instead **ask**, the way OAuth's `/authorize` does:

```
https://your-app.example/app/authorize?name=Raycast&write=0&targets=*
```

| Query | Meaning |
| --- | --- |
| `name` | Shown on the consent screen (required) |
| `write` | `1` / `true` for read and write; omit for read only |
| `targets` | Comma-separated resource subjects. `*` (default) means every workspace the user can currently write to |
| `agent` or `public_key` | DID or public key the app already minted. Preferred: Atomic grants that identity and never copies a secret |
| `redirect_uri` | Optional. After Allow, redirect with `granted=true&agent=…&state=`. Never includes the secret. `https:`, `http://localhost`, or a native scheme only |
| `state` | Correlation id. Also makes the pending request idempotent |

The pending request is stored in a private folder on the user's personal drive (`localId: app-key-requests`). Approving creates or binds an app key; denying deletes the row.

If the app cannot mint a keypair first, omit `agent`. Allow then shows a secret once — the PAT fallback, not the OAuth happy path.
