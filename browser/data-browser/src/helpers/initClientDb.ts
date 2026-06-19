import { ClientDbWorker, perfSpan, type Store } from '@tomic/lib';
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

  /** Compute a cheap fingerprint of the in-memory bootstrap state.
   *  Includes the resource count and a deterministic checksum of the
   *  sorted subject list. A change to any bundled `lib/defaults/*.json`
   *  changes the count or the subjects, so the fingerprint flips and
   *  the seed re-runs on the next page load. Subsequent loads with
   *  unchanged bootstrap data skip the seed entirely. */
  const computeBootstrapFingerprint = (): string => {
    const subjects: string[] = [];

    for (const r of store.resources.values()) {
      if (r.loading || r.new || r.hasPendingCommits) continue;
      subjects.push(r.subject);
    }

    subjects.sort();
    // FNV-1a 32-bit hash of the sorted subject list. Cheap, deterministic,
    // good enough to detect added/removed bootstrap resources. We don't
    // need crypto-grade — the worst-case collision means we miss a
    // reseed on a single deployment, which the next deployment fixes.
    let hash = 0x811c9dc5;

    for (const s of subjects) {
      for (let i = 0; i < s.length; i++) {
        hash ^= s.charCodeAt(i);
        hash = Math.imul(hash, 0x01000193);
      }

      hash ^= 0x2c;
      hash = Math.imul(hash, 0x01000193);
    }

    return `${subjects.length}:${(hash >>> 0).toString(16)}`;
  };

  const FINGERPRINT_KEY = 'atomic.client-db.bootstrap-fingerprint';
  const currentFingerprint = computeBootstrapFingerprint();
  const storedFingerprint =
    typeof localStorage !== 'undefined'
      ? localStorage.getItem(FINGERPRINT_KEY)
      : null;
  const bootstrapChanged = storedFingerprint !== currentFingerprint;

  // Start init — this creates the Worker immediately (sync) and
  // sends the WASM init message (async). Messages sent to the worker
  // before WASM loads will queue and process after init.
  // After WASM is ready, seed the DB from the Store's in-memory map
  // so tables/queries work even without OPFS persistence.
  const endClientDbInit = perfSpan('clientdb.init');
  const initPromise = clientDb.init(store.getServerUrl()).then(async () => {
    endClientDbInit();
    const endPostInit = perfSpan('clientdb.postInit');
    // Skip the seed entirely when:
    //   - The WASM DB is already populated from OPFS (prior session), AND
    //   - The bundled bootstrap data hasn't changed since the last seed
    //     (fingerprint matches).
    //
    // First load: localStorage has no fingerprint → seeds.
    // Subsequent loads with same code: fingerprints match + OPFS has
    //   data → skips. Saves ~200 wasm-bindgen crossings (~1-2s on slow
    //   runners) per cold load.
    // Version bumps that add/remove bootstrap resources: fingerprint
    //   mismatch → reseeds (one-time cost for that version).
    let opfsHasData = false;

    const endAllSubjects = perfSpan('clientdb.allSubjects');
    // Subjects already in the WASM DB. The Rust `ClientDb` runs
    // `populate::bootstrap` inside `init_redb_opfs`, so on a fresh OPFS the
    // ~200 bundled defaults are ALREADY present here — re-seeding them from JS
    // is ~1s of redundant wasm-bindgen crossings. We skip any subject the DB
    // already has and only seed what's genuinely missing (drive, agent,
    // fetched resources).
    const existingSet = new Set<string>();

    try {
      const existing = await clientDb.allSubjects();
      for (const s of existing) existingSet.add(s);
      opfsHasData = existing.length > 0;
    } catch {
      // allSubjects failed — proceed with seed as fallback.
    }

    endAllSubjects({ count: existingSet.size });

    if (opfsHasData && !bootstrapChanged) {
      console.info(
        `[ClientDb] bootstrap fingerprint unchanged (${currentFingerprint}) and OPFS populated, skipping seed`,
      );
      endPostInit({ seeded: false, opfsSubjects: existingSet.size });

      return;
    }

    // Seed the WASM DB from resources already in the Store.
    // Properties must be seeded FIRST so that subsequent resources
    // can be parsed with correct datatype validation.
    const propertyClass = 'https://atomicdata.dev/classes/Property';
    const isAProp = 'https://atomicdata.dev/properties/isA';
    const properties: string[] = [];
    const others: string[] = [];

    let skippedAlreadyPresent = 0;

    // The bundled-defaults fingerprint doubles as a version stamp. We may skip
    // re-seeding subjects the Rust-side bootstrap already populated ONLY when we
    // can trust those values are current — i.e. a genuine first visit, where
    // `init_redb_opfs` just ran `populate::bootstrap` against a fresh OPFS with
    // THIS build's defaults. On a version change (`storedFingerprint` present
    // but different) a default's *value* may have changed under an existing
    // subject, and the Rust bootstrap skips existing OPFS — so we must reseed
    // unfiltered to overwrite. That full reseed is a one-time ~1s cost per
    // version bump; the common first-visit and warm paths stay fast.
    const trustWasmDefaults = storedFingerprint === null;

    for (const resource of store.resources.values()) {
      if (!resource.loading && !resource.new && resource.subject) {
        // Already populated by the Rust-side bootstrap — don't pay the
        // wasm-bindgen crossing to re-insert identical data.
        if (trustWasmDefaults && existingSet.has(resource.subject)) {
          skippedAlreadyPresent++;
          continue;
        }

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
    const endSeed = perfSpan('clientdb.seed');
    const propertyJsonAds = properties
      .map(serializeResource)
      .filter((s): s is string => s !== undefined);
    await clientDb.putResources(propertyJsonAds).catch(() => {});

    // Then seed everything else in one batch too.
    const otherJsonAds = others
      .map(serializeResource)
      .filter((s): s is string => s !== undefined);
    await clientDb.putResources(otherJsonAds).catch(() => {});
    endSeed({
      properties: propertyJsonAds.length,
      others: otherJsonAds.length,
    });

    // Persist the fingerprint AFTER the seed lands so a crashed seed
    // forces a retry on the next load (the stored value would still
    // be the old/empty fingerprint, mismatching the new bundle).
    if (typeof localStorage !== 'undefined') {
      try {
        localStorage.setItem(FINGERPRINT_KEY, currentFingerprint);
      } catch {
        // Quota or privacy mode — non-fatal, just means we'll reseed
        // next load.
      }
    }

    console.info(
      `[ClientDb] seeded ${propertyJsonAds.length} properties + ${otherJsonAds.length} resources, skipped ${skippedAlreadyPresent} already in WASM DB (fingerprint ${currentFingerprint}${bootstrapChanged && storedFingerprint ? `, was ${storedFingerprint}` : ''})`,
    );
    endPostInit({
      seeded: true,
      properties: propertyJsonAds.length,
      others: otherJsonAds.length,
      skippedAlreadyPresent,
    });
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

      // init() resolves even when the local DB parked in a degraded,
      // server-only mode (insecure context with no Web Locks/OPFS, or a
      // ghost-leader lock it couldn't reclaim). Surface that to the user —
      // otherwise the app silently renders empty, unpersisted resources with
      // no explanation of why local caching/offline isn't working.
      if (clientDb.initError) {
        store.notifyError(clientDb.initError);
      }
    })
    .catch(err => {
      console.warn('[ClientDb] Failed to initialize:', err);
      // Re-emit so the Sync page can show the error (clientDbError).
      // clientDb.initError was populated in the send() catch inside doInit.
      store.setClientDb(clientDb);
      store.notifyError(clientDb.initError ?? err);
    });

  // Vite HMR: accept updates and re-initialize cleanly.
  if (import.meta.hot) {
    import.meta.hot.dispose(() => {
      currentWorker?.destroy();
      currentWorker = undefined;
    });
  }
}
