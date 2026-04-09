import { ClientDbWorker, type Store } from '@tomic/lib';

// Track the current worker so we can terminate it on HMR reload.
let currentWorker: ClientDbWorker | undefined;
let offlineRestored = false;

/**
 * Initialize the WASM ClientDb in a Web Worker and attach it to the Store.
 * Uses OPFS for persistent storage — data survives page reloads.
 * Falls back to in-memory if OPFS is unavailable.
 */
export function initClientDb(store: Store): void {
  // Restore offline-saved resources from localStorage FIRST (synchronous).
  // These contain Loro snapshots that the WASM DB can't store.
  // Only run once — HMR re-runs must not overwrite in-memory state.
  if (!offlineRestored) {
    offlineRestored = true;
    const count = store.restoreOfflineResources();

    if (count > 0) {
      console.info(`[Offline] Restored ${count} resources from localStorage`);
    }
  }

  if (typeof Worker === 'undefined') return;

  // Terminate previous worker (important for Vite HMR — releases OPFS lock).
  if (currentWorker) {
    currentWorker.destroy();
    currentWorker = undefined;
  }

  const origin = window.location.origin;
  const wasmUrl = `${origin}/wasm/atomic_wasm.js`;
  const workerUrl = `${origin}/wasm/client-db-worker.js`;

  const clientDb = new ClientDbWorker(wasmUrl, workerUrl);
  currentWorker = clientDb;

  // Start init — this creates the Worker immediately (sync) and
  // sends the WASM init message (async). Messages sent to the worker
  // before WASM loads will queue and process after init.
  // After WASM is ready, seed the DB from the Store's in-memory map
  // so tables/queries work even without OPFS persistence.
  const initPromise = clientDb.init(store.getServerUrl()).then(async () => {
    // Seed the WASM DB from resources already in the Store.
    // Properties must be seeded FIRST so that subsequent resources
    // can be parsed with correct datatype validation.
    const propertyClass = 'https://atomicdata.dev/classes/Property';
    const isAProp = 'https://atomicdata.dev/properties/isA';
    const properties: string[] = [];
    const others: string[] = [];

    for (const resource of store.resources.values()) {
      if (!resource.loading && !resource.new && resource.subject) {
        const isA = resource.get(isAProp);
        const isProperty =
          Array.isArray(isA) && isA.includes(propertyClass);

        if (isProperty) {
          properties.push(resource.subject);
        } else {
          others.push(resource.subject);
        }
      }
    }

    const seedResource = (subject: string): Promise<void> | undefined => {
      const resource = store.resources.get(subject);

      if (!resource) return undefined;

      const obj: Record<string, unknown> = { '@id': resource.subject };
      let hasProps = false;

      for (const [key, value] of resource.getPropVals()) {
        if (value instanceof Uint8Array) continue;
        obj[key] = value;
        hasProps = true;
      }

      if (!hasProps) return undefined;

      return clientDb.putResource(JSON.stringify(obj)).catch(() => {});
    };

    // Seed properties first (serially to avoid race conditions in the parser)
    for (const subject of properties) {
      await seedResource(subject);
    }

    // Then seed everything else in parallel
    const otherPromises = others
      .map(seedResource)
      .filter((p): p is Promise<void> => p !== undefined);
    await Promise.all(otherPromises);

    console.info(
      `[ClientDb] WASM database ready, seeded ${properties.length} properties + ${otherPromises.length} resources`,
    );

    // Debug: check if any loroUpdate was lost during seeding
    for (const key of Object.keys(localStorage)) {
      if (!key.startsWith('atomic.offline.')) continue;
      const subject = key.slice('atomic.offline.'.length);
      const resource = store.resources.get(subject);

      if (resource && !resource.get('https://atomicdata.dev/properties/loroUpdate')) {
        console.error(`[ClientDb] loroUpdate LOST after seeding for ${subject.slice(0, 40)}`);
      }
    }
  });

  // Tell the clientDb to wait for seeding before reporting as ready.
  clientDb.setSeedPromise(initPromise);

  // Attach to store right after init() is called (worker exists now).
  // This lets addResource() forward to the worker even during init.
  store.setClientDb(clientDb);

  initPromise.catch(err => {
    console.warn('[ClientDb] Failed to initialize:', err);
  });

  // Vite HMR: accept updates and re-initialize cleanly.
  if (import.meta.hot) {
    import.meta.hot.dispose(() => {
      currentWorker?.destroy();
      currentWorker = undefined;
    });
  }
}

