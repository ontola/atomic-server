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
    }
  | { id: number; type: 'allSubjects' }
  | { id: number; type: 'populate' }
  | { id: number; type: 'exportAllResources' }
  | { id: number; type: 'importAllResources'; jsonArray: string };

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

self.onmessage = async (event: MessageEvent<WorkerRequest>) => {
  const msg = event.data;

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
};
