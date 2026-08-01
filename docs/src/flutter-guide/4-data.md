{{#title Working with data}}

# Working with data

Atomic data is a typed property graph. Every thing you store is a **resource** with a subject URL and a bag of **properties**. The Flutter SDK writes through the same Loro CRDT engine as the web and server clients, so offline edits merge cleanly when devices meet again.

## Mental model

| Concept | What it means in your app |
| --- | --- |
| **Resource** | One record — a note, a canvas, a folder, a user profile |
| **Subject** | Stable ID (`did:ad:…` for local-first resources) |
| **Property** | Named field with a datatype (`name`, `description`, `parent`, …) |
| **Commit** | Signed mutation (a Loro update) that peers can verify and apply |
| **Class** | Schema hint: which properties a resource is expected to have |

You don't open a SQL connection. You mutate resources; the SDK persists them to the local store and syncs them when a peer or server is available.

## Read and write properties

The high-level API is intentionally small: get and set string property values on a subject in the active workspace.

```dart
import 'package:atomic_lib/atomic_lib.dart';

const nameProp = 'https://atomicdata.dev/properties/name';

final drive = Atomic.activeDrive!;
final title = await Atomic.getProperty(drive, nameProp);

await Atomic.setProperty(drive, nameProp, 'Home workspace');
```

Under the hood that:

1. Loads (or creates) the resource's Loro document
2. Writes the property
3. Signs a commit with the current agent
4. Stores it in the local DB (and queues sync if peers are known)

Property URLs are part of the shared vocabulary — reuse
[standard properties](../schema/intro.md) when you can so other Atomic apps
understand your data.

## Domain helpers

For richer types, `AtomicClient` exposes helpers used by the reference canvas app — create a document, append collaborative strokes, list/rename/delete:

```dart
final subject = await AtomicClient.createCanvas('Ideas');
await AtomicClient.pushStroke(subject, strokeJson);
```

Your product will grow similar helpers for its own classes (notes, tasks, chat threads). The pattern stays the same: construct → sign → local store → sync.

## Mutate collaboratively

Edits are small, mergeable updates — not whole-document replaces. Two people editing at once don't stomp each other; Loro merges the operations. The same idea applies to lists, maps, and rich text across Atomic clients.

## Files & media

Binary assets (images, attachments) go through blob APIs on the store. Keep large files out of property values; store a reference property and sync the blob alongside the resource. The web client has the mature file UX today; Flutter is catching up on the same primitives.

## Next

[Pair devices and optionally add a server](./5-sync.md).
