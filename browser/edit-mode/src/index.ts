/**
 * @tomic/edit-mode: the machinery for "Edit this page".
 *
 * Lets any site rendered from Atomic Data hand visitors an editable,
 * local-first CLONE of the content: a guest agent plus a local-only drive in
 * the visitor's browser. Every edit is a signed CRDT commit; nothing ever
 * reaches a server. The app supplies the content model (which fields exist,
 * how they map to resources); this package supplies the store machinery with
 * the sharp edges already rounded off:
 *
 * - `enableLoro()` runs before any resource work. Without it, resources
 *   reloaded from the local database have no CRDT doc and edits are silently
 *   lost while `save()` still reports success.
 * - The ClientDb worker and WASM must be served as plain same-origin assets
 *   and passed as ABSOLUTE URLs. A bundler `?url` import can inline the
 *   worker as a data: URI, and a data-URL worker runs in an opaque origin
 *   with no access to OPFS or Web Locks: persistence then silently degrades.
 * - Local-only drives are registered BETWEEN genesis and the first save.
 * - If the local database cannot be claimed (ghost `atomic-db-leader` lease;
 *   lock-stealing is Chromium-only), the store runs WITHOUT it rather than
 *   attaching a degraded ClientDb: a degraded worker answers local reads by
 *   asking the server, where local-only resources do not exist. The clone
 *   then lives in memory for the tab; check `persistent` and tell the user.
 */
import {
  Agent,
  Store,
  core,
  Resource,
  JSCryptoProvider,
  ClientDbWorker,
  enableLoro,
} from '@tomic/lib';

export const datatypes = {
  string: 'https://atomicdata.dev/datatypes/string',
  markdown: 'https://atomicdata.dev/datatypes/markdown',
  integer: 'https://atomicdata.dev/datatypes/integer',
  boolean: 'https://atomicdata.dev/datatypes/boolean',
  atomicURL: 'https://atomicdata.dev/datatypes/atomicURL',
  resourceArray: 'https://atomicdata.dev/datatypes/resourceArray',
} as const;

const PROP_CLASS = 'https://atomicdata.dev/classes/Property';
const DRIVE_CLASS = 'https://atomicdata.dev/classes/Drive';
const NAME = 'https://atomicdata.dev/properties/name';
const DESCRIPTION = 'https://atomicdata.dev/properties/description';
const SHORTNAME = 'https://atomicdata.dev/properties/shortname';
const DATATYPE = 'https://atomicdata.dev/properties/datatype';

export interface CloneStoreOptions {
  /** HTTP(S) origin of an Atomic server. Only used to resolve public
   *  vocabulary (property definitions); the clone itself never writes. */
  serverUrl: string;
  /** Absolute same-origin URL of `atomic_wasm.js` (with its `_bg.wasm`
   *  sibling). Copy both from the data-browser build into your static dir. */
  wasmJsUrl: string;
  /** Absolute same-origin URL of `client-db.worker.js` (ships in
   *  `@tomic/lib`'s dist). Do NOT use a bundler `?url` import. */
  workerUrl: string;
  /** Reuse an existing guest agent secret; omit to mint a fresh one. */
  secret?: string;
  /** How long to wait for the local database before degrading to
   *  memory-only. Default 6000 ms. */
  readyTimeoutMs?: number;
}

export interface CloneStore {
  store: Store;
  agent: Agent;
  /** Base64 secret of the (guest) agent; persist it to reopen the clone. */
  secret: string;
  /** False when the local database could not be claimed: the clone works,
   *  but only lives in memory for this tab. Tell the user. */
  persistent: boolean;
}

/** Create a Store wired for local-only editing, with graceful degradation. */
export async function createCloneStore(
  opts: CloneStoreOptions,
): Promise<CloneStore> {
  await enableLoro();
  const store = new Store({ serverUrl: opts.serverUrl });

  const clientDb = new ClientDbWorker(opts.wasmJsUrl, opts.workerUrl);
  await clientDb.init(opts.serverUrl);

  const db = clientDb as unknown as { ready: boolean; destroy(): void };
  const deadline = Date.now() + (opts.readyTimeoutMs ?? 6_000);
  while (!db.ready && Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 300));
  }

  let persistent = true;
  if (db.ready) {
    store.setClientDb(clientDb);
  } else {
    persistent = false;
    try {
      db.destroy();
    } catch {
      /* ignore */
    }
  }

  let agent: Agent;
  let secret: string;
  if (opts.secret) {
    agent = Agent.fromSecret(opts.secret, 'js');
    secret = opts.secret;
  } else {
    const keys = await Agent.generateKeyPair();
    agent = new Agent(
      new JSCryptoProvider(keys.privateKey),
      `did:ad:agent:${keys.publicKey}`,
    );
    secret = Agent.buildSecret(keys.privateKey, agent.subject!);
  }
  store.setAgent(agent);

  return { store, agent, secret, persistent };
}

/** Create a drive that never syncs: registered local-only between genesis
 *  and the first save, owned by the store's agent. */
export async function createLocalOnlyDrive(
  store: Store,
  opts: { name: string; description?: string },
): Promise<Resource> {
  const agent = store.getAgent();
  if (!agent?.subject) throw new Error('Store has no agent');

  const drive = await store.newResource({
    isA: DRIVE_CLASS,
    noParent: true,
    propVals: {
      [NAME]: opts.name,
      ...(opts.description ? { [DESCRIPTION]: opts.description } : {}),
      [core.properties.write]: [agent.subject],
      [core.properties.read]: [agent.subject],
    },
  });
  store.registerLocalOnlyDrive(drive.subject);
  await drive.save();
  return drive;
}

/** Define a Property inside the clone drive (the clone's own vocabulary). */
export async function createProperty(
  store: Store,
  drive: string,
  shortname: string,
  datatype: string,
  description = `Edit-mode clone field: ${shortname}`,
): Promise<Resource> {
  const prop = await store.newResource({
    isA: PROP_CLASS,
    parent: drive,
    propVals: {
      [SHORTNAME]: shortname,
      [DESCRIPTION]: description,
      [DATATYPE]: datatype,
    },
  });
  await prop.save();
  return prop;
}

/** Create a content resource. `values` keys are either full property
 *  subjects, or the special shortcuts `name` / `description`. */
export async function createContentResource(
  store: Store,
  parent: string,
  values: Record<string, string | number | boolean>,
): Promise<Resource> {
  const propVals: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(values)) {
    const subject =
      key === 'name' ? NAME : key === 'description' ? DESCRIPTION : key;
    propVals[subject] = value;
  }
  const resource = await store.newResource({
    parent,
    propVals: propVals as never,
  });
  await resource.save();
  return resource;
}

/* ---------- manifest persistence ---------- */

export function loadManifest<T>(storageKey: string): T | undefined {
  try {
    const raw = localStorage.getItem(storageKey);
    return raw ? (JSON.parse(raw) as T) : undefined;
  } catch {
    return undefined;
  }
}

export function saveManifest<T>(storageKey: string, manifest: T): void {
  localStorage.setItem(storageKey, JSON.stringify(manifest));
}

export function clearManifest(storageKey: string): void {
  localStorage.removeItem(storageKey);
}

/** Best-effort wipe of the origin's local Atomic database (OPFS). */
export async function wipeLocalData(): Promise<void> {
  try {
    const root = await navigator.storage.getDirectory();
    for await (const [name] of (
      root as unknown as { entries(): AsyncIterable<[string, unknown]> }
    ).entries()) {
      await root.removeEntry(name, { recursive: true }).catch(() => {});
    }
  } catch {
    /* OPFS unavailable: nothing durable to wipe */
  }
}
