{{#title Sync, pairing and servers}}

# Sync, pairing & optional servers

Local-first doesn't mean forever alone. Atomic apps sync when the user wants — phone ↔ tablet over P2P, or through an optional AtomicServer when you need relay, search, or invites.

## Device pairing (P2P)

Iroh carries encrypted sync between devices. One device shows a QR; the other scans it. No account linking step.

Prefer the built-in UI — it matches the data-browser's pairing codes (`atomic://pair?…` and `did:ad:node:…`):

```dart
// Dialog: show this device's code + scan another
await PairScreen.show(context);
```

Or drive the lower-level client yourself:

```dart
final nodeId = await AtomicClient.startPeer(); // did:ad:node:…
final result = await AtomicClient.peerSync(scannedNodeId);
// result tells you how many resources moved
```

After pairing, known peers are remembered. Call `Atomic.syncNow()` on launch (or from settings) to reconnect and catch up:

```dart
final report = await Atomic.syncNow();
// report.peersSynced, report.errors, …
```

**UX tip:** put pairing next to "Add this phone" / "Link a device", not buried under developer settings. It's a user feature. `ServerSettingsSection` and `showAgentSettings` already expose it.

## Optional AtomicServer

A server is useful when you want:

- Sync while both devices aren't online at the same time (relay / backup)
- Full-text search across a large drive
- Invite links for people who don't have the app open yet
- A browser that can read the same workspace

```dart
await Atomic.connectServer('https://atomicdata.dev');
await Atomic.syncDriveToServer('https://atomicdata.dev');
```

Built-in UI for the common cases:

```dart
const ServerSettingsSection() // URL, status, register / invite entry points
```

You can also self-host. See [AtomicServer installation](../atomicserver/installation.md). Many apps never need a server in v1 — ship P2P first, add relay when users ask for it.

## Conflict handling

You mostly don't. Loro merges concurrent edits. When two values can't merge (rare for text/lists; possible for "set title to A vs B"), last-write-wins on that property applies with causal history preserved. Design collaborative fields as append-only or CRDT-friendly structures when you can.

## Checklist for shipping

1. **`Atomic.init()`** once from `main()`
2. **`LoginScreen` or `setup` / `resumeSession`** before writing user data
3. **Pairing UX** for second devices (`PairScreen.show`)
4. **Optional server** settings for power users / teams
5. **Export secret** somewhere obvious — lost secret = lost identity
6. Test airplane mode: create data offline, pair later, confirm merge

## Where to go next

- [Flutter SDK reference](../flutter.md) — full API surface & widgets
- [Javascript SDKs](../js-sdks.md) — same data model in TypeScript
- [Agents](../agents.md) · [Commits](../commits/intro.md) · [WebSockets](../websockets.md)
- [Personal Data Store](../usecases/personal-data-store.md)
