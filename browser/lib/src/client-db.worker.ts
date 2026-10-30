/**
 * Web Worker that hosts the WASM ClientDb.
 * Communicates with the main thread via typed postMessage.
 *
 * The WASM module URL is passed as the first message after creation.
 */

import { openClientDb, isStorageBlockedDbError } from './client-db-open.js';
import { wasmBinaryUrl } from './wasm-url.js';
import type {
  ClientDbOutboxWrite,
  ClientDbQueryOpts,
  ClientDbQueryResult,
} from './client-db.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type WasmModule = any;

let db: WasmModule | null = null;
let initPromise: Promise<ClientDbInitTimings> | null = null;

type Rows = Array<{ jsonAd: string | null; snapshot: Uint8Array | null }>;

export interface VaultExportResult {
  objectKey: string;
  sealed: Uint8Array;
  kind: 'pack' | 'checkpoint';
  resources: number;
  unchanged: number;
  tombstones: number;
  coverage: Record<string, number>;
}

export interface VaultImportSummary {
  packsRead: number;
  resourcesRestored: number;
  tombstonesApplied: number;
  objectsSkipped: number;
  objectsUnreadable: number;
}

/** What `init` is asked to open, and with what. */
export interface ClientDbInitRequest {
  wasmUrl: string;
  /** The binary behind `wasmUrl`, compiled by the page ahead of time. */
  wasmModule?: WebAssembly.Module;
  baseUrl?: string;
  /** OPFS file name of the database; the WASM side defaults to the
   *  legacy shared `atomic_data.redb` when omitted. */
  dbName?: string;
  /** Encryption key for the database file. */
  dbKey?: Uint8Array;
  /** Migrate the legacy shared DB into `dbName` before opening. */
  migrateLegacy?: boolean;
  /** Allow discarding an undecryptable `dbName`; see `client-db-open.ts`. */
  discardUndecryptable?: boolean;
  /** Drives that exist only in this browser (`Store.registerLocalOnlyDrive`).
   *  Chat messages are moved into chat log pages for these alone; a drive a
   *  server hosts gets its pages from the server. */
  localOnlyDrives?: string[];
}

/**
 * THE method list of the worker RPC. Each entry is `[request fields, result]`.
 * Everything else derives from it: the `WorkerRequest` wire union, the worker's
 * handler table (`handlers`, which must cover every key), and the typed
 * `call()` the `ClientDbWorker` proxy sends through. Add a method here, add its
 * handler below, and the proxy can call it. A handler that writes sets `dirty`
 * (or calls `flushNow()`), or a reload rolls its writes back.
 */
export interface ClientDbRpc {
  init: [ClientDbInitRequest, ClientDbInitTimings];
  getResource: [{ subject: string }, string | null];
  getResourceWithSnapshot: [{ subject: string }, Rows[number] | null];
  getResourcesWithSnapshots: [{ subjects: string[] }, Rows | null];
  putResource: [{ jsonAd: string }, void];
  putResources: [{ jsonAds: string[] }, void];
  /** Row, index entries and Loro snapshot in one transaction, plus outbox rows
   *  made durable by the same flush, so a crash keeps both or neither. */
  putResourceWithSnapshot: [
    { jsonAd: string; snapshot?: Uint8Array; outbox?: ClientDbOutboxWrite },
    void,
  ];
  /** Written in one transaction and made durable by one flush. */
  putResourcesWithSnapshots: [
    {
      items: {
        jsonAd: string;
        snapshot?: Uint8Array;
        outbox?: ClientDbOutboxWrite;
      }[];
    },
    void,
  ];
  outboxEntries: [{ agent: string }, string[] | null];
  outboxWrite: [{ durable: boolean } & ClientDbOutboxWrite, void];
  applyCommit: [{ commitJsonAd: string }, void];
  applyPeerCommit: [{ commitJsonAd: string }, void];
  removeResource: [{ subject: string }, void];
  query: [ClientDbQueryOpts, ClientDbQueryResult];
  search: [
    {
      query: string;
      limit?: number;
      parents?: string | string[];
      filters?: Record<string, string | number | string[]>;
      includeTrashed?: boolean;
    },
    string[] | null,
  ];
  allSubjects: [object, string[]];
  populate: [object, void];
  flush: [object, void];
  exportAllResources: [object, string];
  importAllResources: [{ jsonArray: string }, number];
  getLoroSnapshot: [{ subject: string }, Uint8Array | null];
  historyAttribution: [{ subject: string }, unknown];
  envelopesFor: [{ subjects: string[] }, string];
  importEnvelopes: [{ envelopes: string }, unknown];
  putBlob: [{ hash: Uint8Array; data: Uint8Array }, void];
  getBlob: [{ hash: Uint8Array }, Uint8Array | null];
  blake3Hash: [{ data: Uint8Array }, Uint8Array];
  getAllVersionVectors: [object, unknown];
  getVersionVectorsForDrive: [{ drive: string }, unknown];
  getDriveSubjects: [{ drive: string }, string[]];
  applyStateUpdates: [{ subjects: string[]; states: Uint8Array[] }, number];
  getVersionVectorsForSubjects: [{ subjects: string[] }, unknown];
  indexPendingSearch: [{ limit: number }, number];
  createPeerSession: [
    { drive: string; expectedPeer?: string; challenge: string },
    number,
  ];
  handlePeerFrame: [
    { session: number; frame: Uint8Array },
    { frames: number[][]; changed: string[]; ephemeral?: number[] },
  ];
  canSendPeerFrame: [{ session: number; subject: string }, boolean];
  closePeerSession: [{ session: number }, void];
  // Cloud Vault. These live in the worker because it holds the only Db handle;
  // the network half stays on the main thread, where the control-plane session
  // and CORS setup already work. What crosses this boundary is ciphertext.
  vaultExport: [
    {
      driveSubject: string;
      key: Uint8Array;
      keyEpoch: number;
      drivePseudonym: string;
      devicePubkey: string;
      segment: number;
      checkpointN: number;
      driveHasCheckpoint: boolean;
      observedLanes: Record<string, number>;
      currentStateOnly?: boolean;
    },
    VaultExportResult | null,
  ];
  vaultImport: [
    {
      key: Uint8Array;
      keyEpoch: number;
      drivePseudonym: string;
      devicePubkey: string;
      objects: { objectKey: string; sealed: Uint8Array }[];
    },
    VaultImportSummary,
  ];
  vaultCommitSegment: [
    { drivePseudonym: string; devicePubkey: string; segment: number },
    void,
  ];
}

export type RpcType = keyof ClientDbRpc;
export type RpcReq<K extends RpcType> = ClientDbRpc[K][0];
export type RpcRes<K extends RpcType> = ClientDbRpc[K][1];

/** Message types sent from main thread to worker: one per RPC method, the
 *  request fields flat beside `type` and the request `id`. */
export type WorkerRequest = {
  [K in RpcType]: { id: number; type: K } & RpcReq<K>;
}[RpcType];

function writeOutbox(write: ClientDbOutboxWrite): void {
  db!.outboxWrite(
    write.agent,
    JSON.stringify(write.puts),
    JSON.stringify(write.deletes),
  );
}

/** Message types sent from worker back to main thread */
export type WorkerResponse =
  | { id: number; type: 'ok'; data?: unknown }
  | { id: number; type: 'error'; message: string };

/** Persist what was written, now. Per-write redb commits use
 *  `Durability::None`; see the periodic tick below. */
function flushNow(): void {
  dirty = true;
  db!.flush();
  dirty = false;
}

type Handlers = {
  [K in RpcType]: (req: RpcReq<K>) => RpcRes<K> | Promise<RpcRes<K>>;
};

const handlers: Handlers = {
  // Return the per-phase init timings so the main thread can fold the
  // worker-side WASM/OPFS boot into its perf trace.
  init: msg => {
    initPromise ??= doInit(
      msg.wasmUrl,
      msg.wasmModule,
      msg.baseUrl,
      msg.dbName,
      msg.dbKey,
      msg.migrateLegacy,
      msg.discardUndecryptable,
      msg.localOnlyDrives,
    );

    return initPromise;
  },
  canSendPeerFrame: m => db!.canSendPeerFrame(m.session, m.subject),
  createPeerSession: m =>
    db!.createPeerSession(m.drive, m.expectedPeer, m.challenge),
  handlePeerFrame: m => db!.handlePeerFrame(m.session, m.frame),
  closePeerSession: m => db!.closePeerSession(m.session),
  getResource: m => db!.getResource(m.subject),
  // One round trip for a whole list: opening a chat asks for every message and
  // part at once, and a postMessage per subject queued behind boot-time sync
  // traffic made that the slow part of the open.
  getResourcesWithSnapshots: async m => {
    const rows: Rows = [];

    for (const subject of m.subjects) {
      rows.push(await db!.getResourceWithSnapshot(subject));
    }

    return rows;
  },
  // One wasm call reads the stored row and its snapshot, without decoding the
  // CRDT history on the way (the tab imports the snapshot into its own doc).
  getResourceWithSnapshot: m => db!.getResourceWithSnapshot(m.subject),
  putResource: async m => {
    await db!.putResource(m.jsonAd);
    dirty = true;
  },
  // Batch put: one postMessage for a whole seed loop. Processed in order, so
  // ordering-sensitive callers (properties seeded before others) are safe.
  putResources: async m => {
    for (const jsonAd of m.jsonAds) {
      await db!.putResource(jsonAd);
    }

    dirty = true;
  },
  putResourceWithSnapshot: async m => {
    // One transaction: row, index entries and the Loro snapshot as the tab
    // holds it. Snapshot omitted for resources without a Loro doc (e.g.
    // Commit resources).
    if (m.snapshot) {
      await db!.putResourceWithSnapshot(m.jsonAd, m.snapshot);
    } else {
      await db!.putResource(m.jsonAd);
    }

    // The outbox entry that says this snapshot still has to reach the server.
    // Both writes commit without fsync, so the one flush below persists them
    // together: redb rolls back every commit after the last durable one, so a
    // crash before it keeps neither, never just one.
    if (m.outbox) writeOutbox(m.outbox);

    // This op is the one `persistToClientDb` uses because its caller
    // (`saveOffline`) needs the write durable the moment its promise resolves:
    // an offline edit has no server copy to fall back on. Leave a periodic
    // retry armed on failure, and reject the RPC so a caller never mistakes an
    // in-memory write for a durable snapshot.
    flushNow();
  },
  // What a burst of `putResourceWithSnapshot` calls costs one at a time: a
  // transaction each, so a page every resource touches (the parent's member
  // list, the name index) is written again per resource. Together they share
  // one commit and one flush.
  putResourcesWithSnapshots: async m => {
    await db!.putResourcesWithSnapshots(
      m.items.map(item => item.jsonAd),
      m.items.map(item => item.snapshot ?? null),
    );

    for (const item of m.items) {
      if (item.outbox) writeOutbox(item.outbox);
    }

    flushNow();
  },
  outboxEntries: m => db!.outboxEntries(m.agent) as string[],
  outboxWrite: m => {
    writeOutbox(m);

    // Envelopes (a signed genesis or destroy) and offline cursors are written
    // durably; a plain dirty bit waits for the periodic tick.
    if (m.durable) flushNow();
    else dirty = true;
  },
  applyPeerCommit: async m => {
    await db!.applyPeerCommit(m.commitJsonAd);
    dirty = true;
  },
  applyCommit: async m => {
    await db!.applyCommit(m.commitJsonAd);
    dirty = true;
  },
  removeResource: async m => {
    await db!.removeResource(m.subject);
    dirty = true;
  },
  query: m =>
    db!.query(
      m.property ?? null,
      m.value ?? null,
      m.sortBy ?? null,
      m.sortDesc ?? null,
      m.limit ?? null,
      m.offset ?? null,
      m.includeResources ?? null,
      m.drive ?? null,
      m.filters ?? null,
      m.aggregation ?? null,
      m.expressionFilters ?? null,
      m.includeTrashed ?? null,
    ),
  search: m =>
    db!.search(
      m.query,
      m.limit ?? null,
      m.parents ?? null,
      m.filters ?? null,
      m.includeTrashed ?? null,
    ),
  allSubjects: () => db!.allSubjects(),
  populate: async () => {
    await db!.populate();
    dirty = true;
  },
  // Durability on demand. Writes commit with `Durability::None` and are only
  // persisted by a later Immediate commit, which otherwise happens on the
  // periodic tick below, so until it lands a reload rolls the writes back.
  // Callers about to do something a rollback would ruin (reload, navigate
  // away, go offline) need to be able to ask for it rather than wait and hope.
  flush: () => {
    db!.flush();
    dirty = false;
  },
  exportAllResources: () => db!.exportAllResources(),
  importAllResources: async m => {
    const count = await db!.importAllResources(m.jsonArray);

    dirty = true;

    return count;
  },
  getLoroSnapshot: m => db!.getLoroSnapshot(m.subject),
  historyAttribution: async m =>
    (await db!.historyAttribution(m.subject)) as string,
  envelopesFor: m => db!.envelopesFor(JSON.stringify(m.subjects)) as string,
  importEnvelopes: async m => {
    const imported = (await db!.importEnvelopes(m.envelopes)) as number;

    dirty = true;

    return imported;
  },
  putBlob: m => {
    db!.putBlob(m.hash, m.data);
    dirty = true;
  },
  getBlob: m => db!.getBlob(m.hash),
  blake3Hash: m => db!.blake3Hash(m.data),
  getAllVersionVectors: () => db!.getAllVersionVectors(),
  vaultExport: m =>
    db!.vaultExport(
      m.driveSubject,
      m.key,
      m.keyEpoch,
      m.drivePseudonym,
      m.devicePubkey,
      m.segment,
      // `checkpoint_n` is a u64 on the Rust side; wasm-bindgen wants a BigInt
      // for it and throws "Cannot convert 1 to a BigInt" for a Number, which
      // failed every automatic backup in the browser.
      BigInt(m.checkpointN),
      m.driveHasCheckpoint,
      m.observedLanes,
      m.currentStateOnly ?? false,
    ),
  vaultImport: async m => {
    const summary = await db!.vaultImport(
      m.key,
      m.keyEpoch,
      m.drivePseudonym,
      m.devicePubkey,
      m.objects,
    );

    // A restore writes a whole drive behind `Durability::None`, and the caller
    // reloads the page the moment this resolves (`onRestored` in `VaultPanel`),
    // so waiting for the 1s tick regularly lost the race: a restore that
    // reported success and silently did nothing. Flush now; we are already
    // inside the work queue, so this cannot race an in-flight mutation.
    try {
      db!.flush();
    } catch (e) {
      // Fall back to the tick rather than failing a restore that did land.
      dirty = true;
      console.error('[ClientDb] flush after vault import failed:', e);
    }

    return summary;
  },
  // Backup completion must survive an immediate reload, or the cursor is lost
  // and the same data uploads again. Keep the retry armed if flush fails, but
  // propagate that failure so the caller cannot report a completed backup.
  vaultCommitSegment: m => {
    db!.vaultCommitSegment(m.drivePseudonym, m.devicePubkey, m.segment);
    flushNow();
  },
  getVersionVectorsForDrive: m => db!.getVersionVectorsForDrive(m.drive),
  // Search entries are about three quarters of a pulled resource's index
  // writes; they are added afterwards by `indexPendingSearch`.
  applyStateUpdates: async m => {
    const applied = await db!.applyStateUpdates(m.subjects, m.states, true);

    dirty = true;

    return applied;
  },
  indexPendingSearch: async m => {
    const done = await db!.indexPendingSearch(m.limit);

    if (done > 0) dirty = true;

    return done;
  },
  getDriveSubjects: m => db!.getDriveSubjects(m.drive),
  getVersionVectorsForSubjects: m =>
    db!.getVersionVectorsForSubjects(m.subjects),
};

/** `init` creates the database, and `flush` has always run without waiting for it. */
const WITHOUT_DB = new Set<RpcType>(['init', 'flush']);

async function handleMessage(msg: WorkerRequest): Promise<unknown> {
  const handler = handlers[msg.type] as
    | ((req: WorkerRequest) => unknown)
    | undefined;

  if (!handler) throw new Error(`Unknown message type: ${msg.type as string}`);
  if (!WITHOUT_DB.has(msg.type)) await ensureInit();

  return handler(msg);
}

/**
 * Per-phase init timings (ms), measured on the worker's own clock and returned
 * to the main thread in the `init` ack so the OPFS/WASM boot — which is
 * otherwise invisible to the main-thread perf trace — shows up in
 * `__atomicPerf`. Durations are clock-independent, so no epoch reconciliation
 * is needed.
 */
export interface ClientDbInitTimings {
  wasmImportMs: number;
  wasmInstantiateMs: number;
  dbOpenMs: number;
  totalMs: number;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

async function doInit(
  wasmUrl: string,
  wasmModule: WebAssembly.Module | undefined,
  baseUrl?: string,
  dbName?: string,
  dbKey?: Uint8Array,
  migrateLegacy?: boolean,
  discardUndecryptable?: boolean,
  localOnlyDrives?: string[],
): Promise<ClientDbInitTimings> {
  // Dynamic import of the WASM glue code.
  // The URL should point to the directory containing atomic_wasm.js and atomic_wasm_bg.wasm
  const t0 = performance.now();
  const wasm = await import(/* webpackIgnore: true */ wasmUrl);
  const t1 = performance.now();
  // Compile + instantiate the WASM module. The binary is named explicitly
  // instead of left to wasm-bindgen's `import.meta.url` default, which would
  // drop any version query on `wasmUrl` and pair this glue with a binary from
  // a different build — see `wasmBinaryUrl`.
  await wasm.default({ module_or_path: wasmModule ?? wasmBinaryUrl(wasmUrl) });
  const t2 = performance.now();

  // One-time migration of the legacy shared DB file into the per-agent
  // `dbName`. Must run BEFORE `ClientDb.open` takes the OPFS handle. A failed
  // migration must not block opening the new DB — the legacy file is left in
  // place for a later attempt.
  if (migrateLegacy && dbName && dbName !== 'atomic_data.redb') {
    try {
      await wasm.migrateLegacyClientDb(dbName, dbKey ?? undefined);
    } catch (e) {
      // When the browser is withholding storage there is no legacy file to
      // migrate and never will be, so this failure is expected and says
      // nothing the open below won't say better. Staying quiet here avoids
      // reporting the same condition twice, with a stack trace, per load.
      if (!isStorageBlockedDbError(e)) {
        console.warn('[ClientDb] legacy DB migration failed:', e);
      }
    }
  }

  // `ClientDb.open` opens the OPFS-backed database (acquire OPFS handle, open
  // redb, run migrations). `openClientDb` adds one recovery step: an existing
  // file this agent's key can no longer decrypt is deleted and recreated — but
  // only when the caller passed `discardUndecryptable`, having established that
  // the key is unrecoverable rather than just missing here. Every other open
  // failure still propagates.
  const opened = await openClientDb(wasm, {
    baseUrl: baseUrl ?? undefined,
    dbName: dbName ?? undefined,
    dbKey: dbKey ?? undefined,
    discardUndecryptable: discardUndecryptable ?? false,
  });
  db = opened.db;
  await migrateIndexKeys(db);
  await migrateMessages(db, localOnlyDrives ?? []);
  const t3 = performance.now();

  return {
    wasmImportMs: round2(t1 - t0),
    wasmInstantiateMs: round2(t2 - t1),
    dbOpenMs: round2(t3 - t2),
    totalMs: round2(t3 - t0),
  };
}

/** Resources the index rebuild handles per slice: small enough to report
 *  often, large enough that the round trips cost nothing. */
const INDEX_MIGRATION_SLICE = 100;

/**
 * Rebuilds the atom indexes of a database written with an older key layout,
 * before anything is served from it (a query would miss rows). Progress goes to
 * the page as `migration-progress` messages. Runs inside `init`, so the page
 * only sees the database as ready once this is done.
 */
async function migrateIndexKeys(opened: WasmModule): Promise<void> {
  if (!opened.indexMigrationPending?.()) return;

  const report = (done: number, total: number, finished: boolean) =>
    self.postMessage({ type: 'migration-progress', done, total, finished });

  report(0, 0, false);

  for (;;) {
    const step = JSON.parse(opened.migrateIndexKeysStep(INDEX_MIGRATION_SLICE));
    report(step.done, step.total, step.finished);

    if (step.finished) return;

    // Let the worker answer other messages (they queue behind `init`).
    await new Promise(resolve => setTimeout(resolve, 0));
  }
}

/** Messages the chat migration handles per slice (whole chats at a time). */
const MESSAGE_MIGRATION_SLICE = 500;

/**
 * Moves old chat messages into chat log pages (`planning/chat-log.md`): the
 * `Message` resources of group chats and comments, then the `ai-message`
 * resources of AI chats. Pages are written for the drives that exist only in
 * this browser; for a drive a server hosts the server makes them and this only
 * drops cached messages that already have their entry. Progress goes to the page
 * as `migration-progress` messages, like the index rebuild. Runs inside
 * `init`.
 */
async function migrateMessages(
  opened: WasmModule,
  localOnlyDrives: string[],
): Promise<void> {
  const drives = JSON.stringify(localOnlyDrives);

  await runChatMigration(opened.messageMigrationPending?.(), () =>
    opened.migrateMessagesStep(MESSAGE_MIGRATION_SLICE, drives),
  );
  await runChatMigration(opened.aiChatMigrationPending?.(), () =>
    opened.migrateAiChatsStep(MESSAGE_MIGRATION_SLICE, drives),
  );
}

async function runChatMigration(
  pending: boolean | undefined,
  step: () => Promise<string>,
): Promise<void> {
  if (!pending) return;

  const report = (done: number, total: number, finished: boolean) =>
    self.postMessage({
      type: 'migration-progress',
      phase: 'messages',
      done,
      total,
      finished,
    });

  report(0, 0, false);

  for (;;) {
    const result = JSON.parse(await step());
    report(result.done, result.total, result.finished);

    if (result.finished) return;

    await new Promise(resolve => setTimeout(resolve, 0));
  }
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

// Per-write redb commits use `Durability::None` (no fsync) for throughput;
// every handler that writes sets `dirty` itself (or flushes on the spot);
// they're only persisted to OPFS once a *subsequent* Immediate commit
// (`db.flush()`) lands. Without that, every write is rolled back on the next
// open (a page reload) — invisible online (the server re-fetches) but data
// loss when offline. So we flush on a short periodic tick whenever there have
// been writes since the last flush, mirroring the native server's flush tick
// (server/src/serve.rs). One fsync amortises a whole sync burst instead of
// paying one per write; an idle tab (no writes) does nothing.
const FLUSH_INTERVAL_MS = 1000;
let dirty = false;

setInterval(() => {
  if (!dirty || !db) return;

  dirty = false;
  // Route the flush through the same queue as writes so it never races an
  // in-flight mutation against the single redb instance.
  workQueue = workQueue.then(async () => {
    try {
      db!.flush();
    } catch (e) {
      // Re-arm so the next tick retries; a transient flush failure shouldn't
      // permanently strand un-persisted writes.
      dirty = true;
      console.error('[ClientDb] OPFS flush failed:', e);
    }
  });
}, FLUSH_INTERVAL_MS);

type ApplyStatesRequest = Extract<WorkerRequest, { type: 'applyStateUpdates' }>;

/** The most resources one coalesced write carries. */
const MAX_COALESCED_STATES = 2000;

/** Pulled states that arrived while the worker was busy, with no other message
 *  between them. They are applied as one transaction, so a page that several
 *  of them touch (a parent's member list, the search index) is written once.
 *  A first pull queues dozens of batches of 100 faster than they are stored. */
let statesBuffer: { msgs: ApplyStatesRequest[]; count: number } | null = null;

function respond(id: number, outcome: { data: unknown } | { error: unknown }) {
  const response: WorkerResponse =
    'error' in outcome
      ? {
          id,
          type: 'error',
          message:
            outcome.error instanceof Error
              ? outcome.error.message
              : String(outcome.error),
        }
      : { id, type: 'ok', data: outcome.data };

  self.postMessage(response);
}

function queueApplyStates(msg: ApplyStatesRequest): void {
  if (statesBuffer && statesBuffer.count < MAX_COALESCED_STATES) {
    statesBuffer.msgs.push(msg);
    statesBuffer.count += msg.subjects.length;

    return;
  }

  const buffer = { msgs: [msg], count: msg.subjects.length };

  statesBuffer = buffer;
  workQueue = workQueue.then(async () => {
    // Messages that piled up while the worker was busy are dispatched before
    // this timer fires, so they join the buffer instead of queueing behind it.
    await new Promise(resolve => setTimeout(resolve, 30));

    if (statesBuffer === buffer) statesBuffer = null;

    try {
      await handleMessage({
        id: msg.id,
        type: 'applyStateUpdates',
        subjects: buffer.msgs.flatMap(m => m.subjects),
        states: buffer.msgs.flatMap(m => m.states),
      });
      dirty = true;
      buffer.msgs.forEach(m => respond(m.id, { data: m.subjects.length }));
    } catch (error) {
      buffer.msgs.forEach(m => respond(m.id, { error }));
    }
  });
}

self.onmessage = (event: MessageEvent<WorkerRequest>) => {
  const msg = event.data;

  if (msg.type === 'applyStateUpdates') {
    queueApplyStates(msg);

    return;
  }

  // Anything else closes the buffer, so a later message cannot overtake it.
  // Envelopes ride along with every chunk of a pull and depend on nothing
  // in it, so they do not.
  if (msg.type !== 'importEnvelopes') statesBuffer = null;
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
