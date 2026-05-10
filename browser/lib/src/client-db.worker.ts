/**
 * Web Worker that hosts the WASM ClientDb.
 * Communicates with the main thread via typed postMessage.
 *
 * The WASM module URL is passed as the first message after creation.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type WasmModule = any;

let db: WasmModule | null = null;
let initPromise: Promise<void> | null = null;

/** Message types sent from main thread to worker */
export type WorkerRequest =
  | { id: number; type: 'init'; wasmUrl: string; baseUrl?: string }
  | { id: number; type: 'getResource'; subject: string }
  | { id: number; type: 'getResourceWithSnapshot'; subject: string }
  | { id: number; type: 'putResource'; jsonAd: string }
  | { id: number; type: 'putResources'; jsonAds: string[] }
  | {
      id: number;
      type: 'putResourceWithSnapshot';
      subject: string;
      jsonAd: string;
      snapshot?: Uint8Array;
    }
  | { id: number; type: 'applyCommit'; commitJsonAd: string }
  | { id: number; type: 'removeResource'; subject: string }
  | {
      id: number;
      type: 'query';
      property?: string;
      value?: string;
      sortBy?: string;
      sortDesc?: boolean;
      limit?: number;
      offset?: number;
      includeResources?: boolean;
      drive?: string;
    }
  | { id: number; type: 'allSubjects' }
  | { id: number; type: 'populate' }
  | { id: number; type: 'exportAllResources' }
  | { id: number; type: 'importAllResources'; jsonArray: string }
  | { id: number; type: 'getLoroSnapshot'; subject: string }
  | { id: number; type: 'putBlob'; hash: Uint8Array; data: Uint8Array }
  | { id: number; type: 'getBlob'; hash: Uint8Array }
  | { id: number; type: 'blake3Hash'; data: Uint8Array }
  | { id: number; type: 'getAllVersionVectors' };

/** Message types sent from worker back to main thread */
export type WorkerResponse =
  | { id: number; type: 'ok'; data?: unknown }
  | { id: number; type: 'error'; message: string };

async function handleMessage(msg: WorkerRequest): Promise<unknown> {
  switch (msg.type) {
    case 'init': {
      if (initPromise) {
        await initPromise;

        return;
      }

      initPromise = doInit(msg.wasmUrl, msg.baseUrl);
      await initPromise;

      return;
    }

    case 'getResource': {
      await ensureInit();

      return db!.getResource(msg.subject);
    }

    case 'getResourceWithSnapshot': {
      // Combined getter for the cold-load fast path: every
      // `fetchResourceWithLocalFallback` used to do two sequential
      // worker round-trips (one for the JSON-AD, one for the Loro
      // snapshot). On a page that mounts 30 useResource hooks that's
      // 60× postMessage cost serially. Returning both in a single
      // response halves the worker traffic — and the caller already
      // ignores the snapshot when JSON-AD is null, so the combined
      // shape doesn't change semantics.
      //
      // Both calls MUST be awaited before being placed in the response
      // object. wasm-bindgen renders `getResource` / `getLoroSnapshot`
      // as Promise-returning JS functions; embedding a Promise in the
      // response makes `postMessage` throw "could not be cloned" and
      // every cold-load OPFS lookup fails — fell back to a much-slower
      // WS GET path, which is what surfaced as widespread e2e timeouts.
      await ensureInit();
      const jsonAd = await db!.getResource(msg.subject);
      const snapshot = jsonAd ? await db!.getLoroSnapshot(msg.subject) : null;

      return { jsonAd: jsonAd ?? null, snapshot: snapshot ?? null };
    }

    case 'putResource': {
      await ensureInit();
      await db!.putResource(msg.jsonAd);

      return;
    }

    case 'putResources': {
      // Batch put: each individual `putResource` call costs one
      // postMessage round-trip. The startup seed loop in the data-
      // browser writes ~200 resources right after the WASM init —
      // batching them into one message saves ~200 postMessages of
      // overhead. The worker still processes them in order, so any
      // ordering-sensitive caller (properties seeded before others)
      // can keep its current sequencing.
      await ensureInit();
      for (const jsonAd of msg.jsonAds) {
        await db!.putResource(jsonAd);
      }

      return;
    }

    case 'putResourceWithSnapshot': {
      // Atomic write: JSON-AD index entry + (optional) Loro snapshot
      // in one postMessage. Snapshot omitted for resources without
      // a Loro doc (e.g. Commit resources).
      await ensureInit();
      await db!.putResource(msg.jsonAd);
      if (msg.snapshot) db!.putLoroSnapshot(msg.subject, msg.snapshot);

      return;
    }

    case 'applyCommit': {
      await ensureInit();
      await db!.applyCommit(msg.commitJsonAd);

      return;
    }

    case 'removeResource': {
      await ensureInit();
      await db!.removeResource(msg.subject);

      return;
    }

    case 'query': {
      await ensureInit();

      return db!.query(
        msg.property ?? null,
        msg.value ?? null,
        msg.sortBy ?? null,
        msg.sortDesc ?? null,
        msg.limit ?? null,
        msg.offset ?? null,
        msg.includeResources ?? null,
        msg.drive ?? null,
      );
    }

    case 'allSubjects': {
      await ensureInit();

      return db!.allSubjects();
    }

    case 'populate': {
      await ensureInit();
      await db!.populate();

      return;
    }

    case 'exportAllResources': {
      await ensureInit();

      return db!.exportAllResources();
    }

    case 'importAllResources': {
      await ensureInit();

      return db!.importAllResources(msg.jsonArray);
    }

    case 'getLoroSnapshot': {
      await ensureInit();

      return db!.getLoroSnapshot(msg.subject);
    }

    case 'putBlob': {
      await ensureInit();
      db!.putBlob(msg.hash, msg.data);

      return;
    }

    case 'getBlob': {
      await ensureInit();

      return db!.getBlob(msg.hash);
    }

    case 'blake3Hash': {
      await ensureInit();

      return db!.blake3Hash(msg.data);
    }

    case 'getAllVersionVectors': {
      await ensureInit();

      return db!.getAllVersionVectors();
    }

    default:
      throw new Error(`Unknown message type: ${(msg as WorkerRequest).type}`);
  }
}

async function doInit(wasmUrl: string, baseUrl?: string): Promise<void> {
  // Dynamic import of the WASM glue code.
  // The URL should point to the directory containing atomic_wasm.js and atomic_wasm_bg.wasm
  const wasm = await import(/* webpackIgnore: true */ wasmUrl);
  await wasm.default();
  db = await new wasm.ClientDb(baseUrl ?? null);
}

async function ensureInit(): Promise<void> {
  if (initPromise) {
    await initPromise;
  }

  if (!db) {
    throw new Error('ClientDb not initialized. Send an "init" message first.');
  }
}

// Serialize all message handling. Without this, an `async self.onmessage`
// dispatcher invokes a fresh handler per incoming message, all running
// concurrently — a `query` posted right after a burst of `putResource`
// messages would race the puts and return empty results because the index
// writes hadn't landed yet. Symptom: on initial drive-sync, every
// `useCollection`/`useChildren` would do a redundant `/query` GET to the
// server because the local DB query came back with 0 hits.
let workQueue: Promise<void> = Promise.resolve();

self.onmessage = (event: MessageEvent<WorkerRequest>) => {
  const msg = event.data;
  workQueue = workQueue.then(async () => {
    try {
      const data = await handleMessage(msg);
      const response: WorkerResponse = { id: msg.id, type: 'ok', data };
      self.postMessage(response);
    } catch (e) {
      const response: WorkerResponse = {
        id: msg.id,
        type: 'error',
        message: e instanceof Error ? e.message : String(e),
      };
      self.postMessage(response);
    }
  });
};
