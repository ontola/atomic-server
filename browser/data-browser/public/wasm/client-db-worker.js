/**
 * DedicatedWorker that hosts the WASM ClientDb.
 *
 * Owns the OPFS sync access handle directly. A dedicated worker per tab is
 * the pragmatic endpoint: `FileSystemFileHandle.createSyncAccessHandle` is
 * available in `DedicatedWorkerGlobalScope` in every evergreen browser, and
 * this avoids the SharedWorker + nested-DedicatedWorker pattern that broke
 * in Playwright (Chromium headless did not expose `Worker` inside
 * SharedWorker scope) and earlier in Firefox/Safari (no sync access handle
 * in SharedWorker).
 *
 * Consequence: OPFS is exclusive across tabs of the same origin. A second
 * tab will hard-fail on WASM init with `NoModificationAllowedError`. The
 * multi-tab case is the open follow-up; single-tab reliability here matters
 * more for tests and day-to-day use.
 */

console.log('[client-db-worker] dedicated worker loading');

let db = null;
let initPromise = null;

async function doInit(wasmUrl, baseUrl) {
  console.log('[client-db-worker] doInit: importing', wasmUrl);
  const wasm = await import(wasmUrl);
  console.log('[client-db-worker] doInit: wasm module loaded, calling default()');
  await wasm.default();
  console.log('[client-db-worker] doInit: wasm.default() done, creating ClientDb');
  db = await new wasm.ClientDb(baseUrl ?? null);
  console.log('[client-db-worker] doInit: ClientDb ready');
}

async function ensureInit() {
  if (initPromise) await initPromise;
  if (!db) throw new Error('ClientDb not initialized');
}

async function handleMessage(msg) {
  switch (msg.type) {
    case 'init':
      if (!initPromise) {
        initPromise = doInit(msg.wasmUrl, msg.baseUrl);
      }
      await initPromise;
      return;

    case 'shutdown':
      console.log('[client-db-worker] shutdown requested');
      setTimeout(() => self.close(), 0);
      return;

    case 'getResource':
      await ensureInit();
      return db.getResource(msg.subject);

    case 'putResource':
      await ensureInit();
      await db.putResource(msg.jsonAd);
      return;

    case 'applyCommit':
      await ensureInit();
      await db.applyCommit(msg.commitJsonAd);
      return;

    case 'removeResource':
      await ensureInit();
      await db.removeResource(msg.subject);
      return;

    case 'query':
      await ensureInit();
      return db.query(
        msg.property ?? null,
        msg.value ?? null,
        msg.sortBy ?? null,
        msg.sortDesc ?? null,
        msg.limit ?? null,
        msg.offset ?? null,
        msg.includeResources ?? null,
        msg.drive ?? null,
      );

    case 'allSubjects':
      await ensureInit();
      return db.allSubjects();

    case 'populate':
      await ensureInit();
      await db.populate();
      return;

    case 'exportAllResources':
      await ensureInit();
      return db.exportAllResources();

    case 'importAllResources':
      await ensureInit();
      return db.importAllResources(msg.jsonArray);

    case 'putLoroSnapshot':
      await ensureInit();
      db.putLoroSnapshot(msg.subject, msg.data);
      return;

    case 'getLoroSnapshot':
      await ensureInit();
      return db.getLoroSnapshot(msg.subject);

    case 'getAllVersionVectors':
      await ensureInit();
      return db.getAllVersionVectors();

    default:
      throw new Error(`Unknown message type: ${msg.type}`);
  }
}

self.onmessage = async (event) => {
  const msg = event.data;
  try {
    const data = await handleMessage(msg);
    self.postMessage({ id: msg.id, type: 'ok', data });
  } catch (e) {
    self.postMessage({
      id: msg.id,
      type: 'error',
      message: e instanceof Error ? e.message : String(e),
    });
  }
};
