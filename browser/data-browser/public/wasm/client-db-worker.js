/**
 * Standalone Web Worker that hosts the WASM ClientDb.
 * This file is served from /wasm/ and loaded as a module worker.
 */

let db = null;
let initPromise = null;

async function doInit(wasmUrl, baseUrl) {
  const wasm = await import(wasmUrl);
  await wasm.default();
  db = await new wasm.ClientDb(baseUrl ?? null);
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
