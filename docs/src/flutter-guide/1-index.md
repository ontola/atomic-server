{{#title Build a local-first Flutter app with Atomic}}

# Build a local-first Flutter app with Atomic

This guide walks you through shipping a **local-first** Flutter app with
[`atomic_lib`](../flutter.md): data lives on the device, sync is optional, and
you do not stand up Postgres or learn a custom backend stack to get started.

You will:

1. Understand why local-first matters, and what Atomic takes off your plate
2. Create a Flutter app and add `atomic_lib`
3. Give users an identity and a workspace
4. Store and edit app data as Atomic resources
5. Sync across phones (and optionally an always-on server) with the built-in UI

Estimated time: an afternoon for a small notes- or habits-style app.

## Why local-first?

Most apps treat the network as the source of truth: open the app → wait for the
API → hope the server is up. That model is simple for the backend team and
painful for everyone else.

Local-first flips it:

| Cloud-first | Local-first |
| --- | --- |
| Empty screen until the request returns | Instant UI from the device |
| Offline is an error state | Offline is the default |
| Vendor hosts (and often owns) your data | User’s device holds the data |
| Sync means “our servers” | Sync means “the devices you choose” |
| Schema + auth + backup are your problem | Shared primitives across apps |

Benefits you feel in the product:

- **Snappy.** Reads and writes hit a local store. No spinner for every keystroke.
- **Works on a plane.** Edits queue; peers catch up when someone is reachable.
- **Users keep control.** An agent secret is their account — not an email owned
  by your SaaS.
- **You ship features, not infrastructure.** Persistence, signing, and sync are
  already solved.

Local-first is not “never use a server.” An always-on device (an AtomicServer,
or a desktop that stays on) is still useful for backup and for browsers that
cannot be peers. It is optional for day one.

## What Atomic makes easier

Plenty of local-first stacks give you a CRDT and a sync pipe. Atomic also gives
you a **shared data language** so apps and devices can understand each other.

| Problem | Without Atomic | With `atomic_lib` |
| --- | --- | --- |
| Identity | Roll your own auth, tokens, refresh | Ed25519 **agent** + one secret string |
| Storage | Pick a DB, migrations, conflict rules | Embedded node (Loro CRDT + redb) |
| Multi-device | Custom sync protocol or BaaS lock-in | Pairing codes + Iroh / WebSocket sync |
| Sharing across apps | Export/import, one-off schemas | Same resources, properties, commits |
| UI for the hard bits | Build QR pairing, drive switchers yourself | `LoginScreen`, `PairScreen`, settings |
| Server ops | Postgres, TLS, backups before MVP | Server optional until you need backup |

Atomic Data is [linked data that developers can actually ship](../motivation.md):
every property has a URL, commits are signed, and the same model powers the
browser ([`@tomic/lib`](../js.md)), Rust ([`atomic-lib`](../rust-lib.md)), and
this Flutter SDK.

You are not inventing “notes sync v3.” You are writing an app on a graph that
other Atomic apps can already speak.

## Architecture in one picture

```text
┌─────────────────────────────────────┐
│           Your Flutter UI           │
│   (screens, widgets, your domain)   │
└─────────────────┬───────────────────┘
                  │ package:atomic_lib
┌─────────────────▼───────────────────┐
│  Atomic API + reusable sync UI      │
│  Login · Pair · DriveSwitcher · …   │
└─────────────────┬───────────────────┘
                  │ flutter_rust_bridge
┌─────────────────▼───────────────────┐
│  Local Atomic node (Rust atomic_lib)│
│  agents · workspaces · Loro · redb  │
└─────────────────┬───────────────────┘
                  │ optional
     ┌────────────┼────────────┐
     ▼            ▼            ▼
  Other phone   Desktop     AtomicServer
  (Iroh pair)   (Iroh)      (WS / backup)
```

## Prerequisites

- Flutter 3.22+ (stable)
- An Android emulator, iOS simulator, or desktop target
- No AtomicServer required for the first chapters

## Chapters

1. **[Setup](2-setup.md)** — create the project, add `atomic_lib`, boot the node
2. **[Identity & workspaces](3-identity.md)** — agents, secrets, drives
3. **[Your data](4-data.md)** — properties, create/edit resources
4. **[Sync & pairing](5-sync.md)** — QR codes, always-on devices, ship checklist
