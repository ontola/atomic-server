import { ClientDbWorker, type Store } from '@tomic/lib';
// Vite resolves the bundled worker from the lib's dist and gives us a URL
// pointing at the asset it copies into the build output.
import clientDbWorkerUrl from '@tomic/lib/client-db.worker.js?url';

// Track the current worker so we can terminate it on HMR reload.
let currentWorker: ClientDbWorker | undefined;

/**
 * Initialize the WASM ClientDb in a SharedWorker and attach it to the Store.
 * Uses OPFS for persistent storage — data survives page reloads. Singleton
 * per origin, so all tabs talk to one DB instance automatically.
 */
export function initClientDb(store: Store): void {
  if (typeof SharedWorker === 'undefined') return;

  // Disconnect the previous port on HMR. Another tab (or the post-HMR tab
  // itself) will keep the SharedWorker alive; we just reattach a fresh port.
  if (currentWorker) {
    currentWorker.destroy();
    currentWorker = undefined;
  }

  const origin = window.location.origin;
  const wasmUrl = `${origin}/wasm/atomic_wasm.js`;

  const clientDb = new ClientDbWorker(wasmUrl, clientDbWorkerUrl);
  currentWorker = clientDb;

  const serializeResource = (subject: string): string | undefined => {
    const resource = store.resources.get(subject);
    if (!resource) return undefined;

    // Skip resources whose commits haven't reached the server. Two cases:
    //   1. Unsaved placeholders (e.g. `TableNewRow`'s pre-created empty
    //      row): `signChanges` was called — flipping `new=false` and
    //      queueing a commit — but `pushCommits` never ran. Seeding these
    //      turns them into phantom children that accumulate every reload.
    //   2. Offline-applied resources: `applyPendingCommitsLocally` already
    //      persists them directly via `clientDb.putResource`. Seeding
    //      again here is redundant.
    // Genuinely-saved resources have an empty pending queue by the time
    // this seeder runs, so they are the ones that actually land in OPFS.
    if (resource.hasPendingCommits || resource.new) return undefined;

    const obj: Record<string, unknown> = { '@id': resource.subject };
    let hasProps = false;
    for (const [key, value] of resource.getEntries()) {
      if (value instanceof Uint8Array) continue;
      obj[key] = value;
      hasProps = true;
    }
    if (!hasProps) return undefined;
    return JSON.stringify(obj);
  };

  // Start init — this creates the Worker immediately (sync) and
  // sends the WASM init message (async). Messages sent to the worker
  // before WASM loads will queue and process after init.
  // After WASM is ready, seed the DB from the Store's in-memory map
  // so tables/queries work even without OPFS persistence.
  const initPromise = clientDb.init(store.getServerUrl()).then(async () => {
    // Skip seeding entirely if the WASM DB already has data from a prior
    // session (OPFS persists). The bootstrap resources are stable — they
    // don't change between sessions — so a non-empty index means the
    // seed has already happened and we can save ~200 puts × wasm-bindgen
    // crossings (~1s of cold-load time on a slow runner).
    let alreadyPopulated = false;
    try {
      const existing = await clientDb.allSubjects();
      alreadyPopulated = existing.length > 0;
    } catch {
      // allSubjects failed — proceed with seed as fallback.
    }
    if (alreadyPopulated) {
      console.info(
        '[ClientDb] WASM database already populated from OPFS, skipping seed',
      );
      return;
    }

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
        const isProperty = Array.isArray(isA) && isA.includes(propertyClass);

        if (isProperty) {
          properties.push(resource.subject);
        } else {
          others.push(resource.subject);
        }
      }
    }

    // Properties must be seeded first so subsequent resources parse with
    // correct datatype validation. Used to be 70 sequential `putResource`
    // round-trips (~350 ms of dead time on cold start); batch them into
    // one worker call. The worker still processes them in order, so the
    // datatype-priming property is preserved.
    const propertyJsonAds = properties
      .map(serializeResource)
      .filter((s): s is string => s !== undefined);
    await clientDb.putResources(propertyJsonAds).catch(() => {});

    // Then seed everything else in one batch too.
    const otherJsonAds = others
      .map(serializeResource)
      .filter((s): s is string => s !== undefined);
    await clientDb.putResources(otherJsonAds).catch(() => {});

    console.info(
      `[ClientDb] WASM database ready, seeded ${propertyJsonAds.length} properties + ${otherJsonAds.length} resources`,
    );
  });

  // Tell the clientDb to wait for seeding before reporting as ready.
  clientDb.setSeedPromise(initPromise);

  // Attach to store right after init() is called (worker exists now).
  // This lets addResource() forward to the worker even during init.
  store.setClientDb(clientDb);

  initPromise
    .then(() => {
      // Re-emit so the sync page picks up clientDbReady: true.
      // The previous "safety net" reseed at this point — every
      // resource in `store.resources` re-pushed to the WASM index
      // through wasm-bindgen — was solving a race that already had a
      // guard: `ClientDbWorker.send()` awaits its own `initPromise`
      // before forwarding to the worker, so any `addResource →
      // clientDb.putResourceWithSnapshot` call that landed during the
      // init window queued automatically. The reseed was paying ~1s
      // of wasm-bindgen crossings every cold load for zero new state.
      store.setClientDb(clientDb);
    })
    .catch(err => {
      console.warn('[ClientDb] Failed to initialize:', err);
      // Re-emit so the Sync page can show the error (clientDbError).
      // clientDb.initError was populated in the send() catch inside doInit.
      store.setClientDb(clientDb);
    });

  // Vite HMR: accept updates and re-initialize cleanly.
  if (import.meta.hot) {
    import.meta.hot.dispose(() => {
      currentWorker?.destroy();
      currentWorker = undefined;
    });
  }
}
