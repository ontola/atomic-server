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

## What you have

A single-device app that survives reloads, with an encrypted local database and version history, and still no server.
The next step adds one, so the reading list can reach a second browser and a colleague.

Next: [syncing to an always-on device](5-sync-server.md).
