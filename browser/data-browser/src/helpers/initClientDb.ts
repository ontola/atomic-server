import { ClientDbWorker, type Store } from '@tomic/lib';

/**
 * Initialize the WASM ClientDb in a Web Worker and attach it to the Store.
 * Uses OPFS for persistent storage — data survives page reloads.
 * Falls back to in-memory if OPFS is unavailable.
 */
export function initClientDb(store: Store): void {
  if (typeof Worker === 'undefined') return;

  const origin = window.location.origin;
  const wasmUrl = `${origin}/wasm/atomic_wasm.js`;
  const workerUrl = `${origin}/wasm/client-db-worker.js`;

  const clientDb = new ClientDbWorker(wasmUrl, workerUrl);

  // Start init — this creates the Worker immediately (sync) and
  // sends the WASM init message (async). Messages sent to the worker
  // before WASM loads will queue and process after init.
  const initPromise = clientDb.init(store.getServerUrl());

  // Attach to store right after init() is called (worker exists now).
  // This lets addResource() forward to the worker even during init.
  store.setClientDb(clientDb);

  initPromise.then(() => {
    console.info('[ClientDb] WASM database ready');
  }).catch(err => {
    console.warn('[ClientDb] Failed to initialize:', err);
  });
}
