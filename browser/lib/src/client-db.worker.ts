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
  | { id: number; type: 'putResource'; jsonAd: string }
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
  | { id: number; type: 'putLoroSnapshot'; subject: string; data: Uint8Array }
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

    case 'putResource': {
      await ensureInit();
      await db!.putResource(msg.jsonAd);

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

    case 'putLoroSnapshot': {
      await ensureInit();
      db!.putLoroSnapshot(msg.subject, msg.data);

      return;
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
