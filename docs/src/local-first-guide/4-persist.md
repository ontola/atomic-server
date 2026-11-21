# Step 3: persist across reloads

The Store keeps resources in memory.
Durable storage in the browser comes from the **client database**: the same Rust store that powers AtomicServer, compiled to WASM, writing an encrypted file to the Origin Private File System (OPFS).
It runs in a dedicated worker; one tab per origin owns the file and the others talk to it over a `BroadcastChannel`, so several tabs share one database.

## Where the WASM comes from

The worker script ships inside `@tomic/lib`.
The WASM module does not, yet: it is built from the repository's `wasm/` crate and served by your app as static files.
Build it once and copy the two output files into your public folder:

```sh
# in a checkout of atomic-server
cd wasm
wasm-pack build --target web --out-dir pkg
cp pkg/atomic_wasm.js pkg/atomic_wasm_bg.wasm /path/to/your-app/public/wasm/
```

Publishing this as a package so the step becomes an `npm install` is on the [roadmap](../roadmap.md).

## Attach the database to the Store

```ts
import { ClientDbWorker, Store } from '@tomic/lib';
import workerUrl from '@tomic/lib/client-db.worker.js?url'; // Vite syntax

const clientDb = new ClientDbWorker(
  `${location.origin}/wasm/atomic_wasm.js`,
  workerUrl,
  {
    // One file per Agent, so two identities on the same origin never share a
    // cache. Derive the name from the subject however you like.
    dbName: `reading-list.${hash(agent.subject)}.redb`,
    // 32 random bytes. Keep them with the secret; without the key the file is
    // unreadable, which is the point.
    dbKey: loadOrCreateDbKey(agent.subject),
  },
);

const store = new Store({ agent });
store.setClientDb(clientDb);
await clientDb.init();
```

The order matters: attach first, then initialize.
Reads that happen while the worker is still opening the file wait for it instead of failing.

## What changes

- **Reads hit the database first.** `getResource` returns the stored copy without a network request, and only fetches when the resource is not present locally.
- **Writes are persisted with their history.** Each Resource's Loro snapshot is stored next to its properties, so version history survives a reload and offline edits made before a reload are still in the outbox afterwards.
- **Queries run locally.** `store.queryLocalDb` and `store.search` work against the local database, with the same index the server uses.

Reload the page: the Drive and the Book are still there, and the outbox still knows the Book has never been sent anywhere.

## Observe save completion

Await the save separately from changing a value:

```ts
await book.set(titleProperty, 'A new title');

try {
  const result = await book.save();
  // Inspect the result before proceeding with an action that needs the save.
} catch (error) {
  // Keep the editor open and offer retry when storage or connectivity recovers.
  console.error('The save did not complete', error);
}
```

For an offline save, or a resource in a local-only drive, the client database
must accept the resource snapshot and complete its flush before the save reports
success. Missing or unsupported local storage and failed writes reject the save.
Local-only saves retain their signed commits in memory after failure so retry can
store the original genesis and history; leaving the page before retry succeeds can
still lose those changes. A localStorage outbox alone does not store the resource
snapshot and cannot satisfy this requirement.

Interpret the result in context:

- `persisted` means the configured commit destination accepted the write, or a
  local-only resource completed its local write. For an online save, the subsequent
  local mirror is best effort: its failure does not undo remote acceptance.
- The offline persistence path returns `offline` after storing the snapshot and
  pending work locally for later delivery.
- `noop` means there were no changes to save; it is not a fresh storage receipt.

A child waiting for an unsaved parent only enters an in-memory batch; the local
persistence path has not run yet. Save the parent and await the child's own
completed save before relying on it. Older versions also return `offline` for
this case, so that result alone is insufficient proof of local storage.

Use `store.getSaveState(book)` and `store.subscribeSaveState(book, callback)` for
progress, or `useSaveState(book)` in React. These report `idle`, `dirty`,
`scheduled`, `saving`, `queued`, and `error`, with an optional `reason` and `error`
message. They describe work in progress, not a durable receipt for a particular
version. Awaiting a `useValue` setter only waits for local processing; with
`commit: true` it schedules a separate debounced save.

These signals do not prove that a server flushed its disk or that an independent
second replica has the change. Tabs sharing one client database are one stored
copy. Browser storage can also be cleared or evicted. Version-specific local and
remote receipts are follow-up work tracked in
[issue #2538](https://github.com/ontola/atomic-server/issues/2538).

## What you have

A single-device app that survives reloads, with an encrypted local database and version history, and still no server.
The next step adds one, so the reading list can reach a second browser and a colleague.

Next: [syncing to an always-on device](5-sync-server.md).
