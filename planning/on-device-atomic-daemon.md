# On-device Atomic daemon — one store, many apps

> Status: draft / design. No code yet. Owns the "multiple apps on one device
> share Atomic user data" question raised while building device sync.
> **Android update:** [`android-data-reuse.md`](./android-data-reuse.md)
> supersedes the localhost-HTTP transport on Android with Binder IPC
> (on-demand ContentProvider/AIDL + cert-bound caller identity); the daemon
> shape below may still fit desktop.

## Goal

Make Atomic a **reusable local data layer** that more than one app on the same
device can build on, instead of each app embedding its own private copy of the
store and identity. Concretely, on a phone running both **atomic-server (Tauri)**
and **atomic-canvas (Flutter)**:

- one copy of the user's data, not one per app;
- one identity (agent secret) and one device identity (Iroh node);
- sign in once — every Atomic app is already "you";
- real-time and offline still work.

The user is fine reaching the shared layer **over localhost**. That is the crux
of the design: the device runs its own personal Atomic node, and every app is a
**client** of it — the exact client/server relationship the data-browser already
has with a hosted server. "A server is just an always-on device"
([`sync-onboarding-ux.md`](./sync-onboarding-ux.md)) taken to its conclusion: the
always-on device is *this* one.

## Why this shape (and not a shared file)

Two dead ends rule out the naive "point both apps at the same database":

- **Android sandboxing.** Each app has a private data dir no other app may read.
  `sharedUserId` is deprecated and being removed; scoped storage is not meant for
  a live database. There is no clean modern way to share a DB *file* between apps.
- **redb is single-writer.** Even if two processes could see the same file, redb
  takes an exclusive lock — the literal `Database already open. Cannot acquire
  lock` we hit during this work. Two processes cannot both open the store.

So "shared store" cannot mean shared memory-mapped file. It must mean **one
process owns the store; the others talk to it.** Over localhost, that owner is an
ordinary Atomic node serving HTTP + WS, and the clients are ordinary Atomic
clients. Nothing new in the protocol — the browser already exercises all of it.

## Architecture

```
        ┌───────────────────────────────────────────────┐
        │  Device                                         │
        │                                                 │
        │   ┌───────────── Atomic daemon ─────────────┐   │
        │   │  redb store  ·  agent secret            │   │
        │   │  Iroh node   ·  HTTP + WS on localhost   │   │
        │   └───────────────▲──────────────▲──────────┘   │
        │        localhost   │              │  localhost   │
        │   ┌────────────────┴───┐   ┌──────┴───────────┐  │
        │   │  atomic-canvas     │   │  atomic-browser  │  │
        │   │  (Flutter client + │   │  (web client)    │  │
        │   │   local Loro cache)│   │                  │  │
        │   └────────────────────┘   └──────────────────┘  │
        └───────────────────────────────────────────────┘
                              │ Iroh / relay
                              ▼
                     other devices (phone, laptop, hosted server)
```

- **The daemon** is the single owner of `redb` + secret + Iroh node. It is the
  only process that opens the store. It serves the same HTTP/WS the hosted
  atomic-server does, bound to loopback.
- **Clients** (canvas, browser, future apps) read/write over HTTP and take live
  updates over WS. A client MAY keep a local Loro doc for offline + instant
  local echo, syncing it to the daemon like a peer — but the daemon holds the
  authoritative copy. This preserves canvas's local-first feel without a second
  authoritative store.
- **Cross-device sync** is unchanged: the daemon's Iroh node syncs with other
  devices exactly as today. Apps no longer each maintain their own node, so a
  device presents as **one** peer, not N.

## The four hard problems

### 1. Single-owner daemon (not "first app wins")

Because of the redb lock, exactly one process must host the store. Options:

- **(a) The server app hosts a foreground Service.** Other apps connect over
  localhost. Simple; but uninstalling the server app decapitates the others.
- **(b) A dedicated tiny "Atomic daemon" app** whose only job is the Service;
  every app (including the server UI) is a client. Cleanest separation, most
  packaging work, extra install.
- **(c) Bound Service in a shared library any app can start.** Whichever app is
  up hosts it; others bind. Coordination + hand-off on host death is fiddly and
  races the redb lock.

Leaning **(a)** first (server app already exists and is the natural owner),
revisit **(b)** if the coupling hurts.

### 2. Android lifecycle

Background services are killed. Keeping the node alive means a **foreground
service** with a persistent notification, or on-demand start when a client binds
plus graceful store close on stop. Store durability matters here — see the
`store.flush()` work; an unclean kill must not lose the secret or recent writes.

### 3. Canvas becomes a client

Today atomic-canvas compiles `atomic_lib` in and owns a store via
flutter_rust_bridge. To share the daemon's store it must instead **talk to
localhost** for reads/writes and take WS live updates — what the browser already
does. It can keep Loro locally for offline/real-time and sync those docs to the
daemon over the peer/WS protocol, so it does not lose local-first. This is the
**largest** piece of work, but the client path is already proven by the browser.

Open sub-question: does canvas keep an embedded `atomic_lib` (as a *local cache
+ peer of the daemon*), or become a thin HTTP/WS client with no Rust store? The
former keeps offline and instant undo with least behavioral change; the latter
is simpler but leans on the daemon being always-up on-device.

### 4. On-device client authorization (the sneaky one)

A localhost server is reachable by **any** app on the device (and other devices
if it ever binds beyond loopback). So the daemon must authorize clients — it
cannot treat "came from localhost" as trust. This is where *share-store* and
*share-secret* merge: to act as the user, a client needs a credential. Two
models:

- **Shared raw secret.** Each client app holds the agent secret and signs
  requests (today's scheme). Simplest; but the secret is now copied into every
  app's sandbox — larger blast radius if one app is compromised.
- **Delegated per-app credential.** The daemon mints a scoped agent/token per
  paired client on first connect (a local "pairing" handshake, e.g. a user tap
  in the daemon UI, or an Android intent with a one-time code). The client signs
  with *its* credential; the daemon maps it to the user with app-scoped rights.
  Safer, revocable per app, but needs a delegation/grants model.

Preference: ship with the **shared secret** to unblock, design toward
**delegated credentials**. Note this reuses the same "grants / cross-agent"
territory flagged in the sync authorization work.

## Phasing

- **Phase 0 — shared secret handoff (cheap, standalone).** One app can hand its
  agent secret to another via an Android intent / deep link (or Android
  Keystore), so signing into one app offers to sign the other in. Both apps stay
  as they are (own store, own node) and reconcile over Iroh loopback. Delivers
  "sign in once" immediately, no architecture change. Wasteful (two copies, two
  nodes, loopback sync) but correct.
- **Phase 1 — on-device daemon + canvas as client.** Stand up the foreground
  Service hosting the node; make canvas connect to it (option 3 above), retiring
  canvas's authoritative store. One copy of data, one node.
- **Phase 2 — delegated client auth.** Replace the shared raw secret with
  per-app delegated credentials (problem 4), revocable from the daemon.

## Open questions

- **Daemon owner:** server app (a) vs dedicated daemon app (b)? Impacts install
  UX and the "uninstall decapitates others" coupling.
- **Canvas store:** local-cache-peer vs thin client (problem 3 sub-question)?
- **Auth model & timing:** how early do we move off the shared secret; does the
  delegation reuse the grants work from cross-agent sync?
- **Port / discovery on-device:** fixed `9883`, or a discovery handshake so a
  client finds the daemon without a hardcoded port? Fixed port collides if two
  owners ever race (problem 1).
- **iOS / desktop parity:** the same daemon shape should generalize; anything
  Android-specific here (Service, intents) needs a desktop/iOS equivalent.
- **Failure UX:** what a client shows when the daemon is down / not installed.

## Relationship to existing work

- Builds directly on the sync work: relayed-drive authorization
  (`may_accept_drive_write`), stored-relay re-dial, local mDNS discovery, and
  the durability (`store.flush()`) fixes all apply to the daemon's node.
- The client protocol is the one the data-browser already speaks; the
  onboarding vocabulary is in [`sync-onboarding-ux.md`](./sync-onboarding-ux.md).
- Delegated client auth overlaps the cross-agent / grants direction noted when
  the "same-agent only" rule was removed.
