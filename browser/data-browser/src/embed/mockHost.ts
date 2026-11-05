import {
  dataBrowser,
  decodeB64,
  enableLoro,
  encodeB64,
  LoroLoader,
  generateKeyPair,
  server,
  signBytesWithKey,
  type NativeChannel,
} from '@tomic/lib';
import baseModels from '@repo-lib-defaults/default_base_models.json';
import defaultStore from '@repo-lib-defaults/default_store.json';

type JsonAd = Record<string, unknown> & { '@id': string };

const NAME = 'https://atomicdata.dev/properties/name';
const PARENT = 'https://atomicdata.dev/properties/parent';
const IS_A = 'https://atomicdata.dev/properties/isA';
const DRIVE = server.classes.drive;
const FOLDER = dataBrowser.classes.folder;
const DESCRIPTION = 'https://atomicdata.dev/properties/description';

/** Where the memory host keeps a resource: `{jsonAd, snapshot}` (base64
 *  Loro snapshot or null). A host page in the same tab can put a resource
 *  here before it opens the editor on it. */
export const MEMORY_HOST_PREFIX = 'atomic-embed-memory:';

/** The memory host's agent key pair (base64url), made once per tab. */
const MEMORY_HOST_KEY = 'atomic-embed-memory-agent';

/** The tab's own agent: the memory host signs the page's commits with it, so
 *  the editor is writable (a DID agent may edit DID resources). */
async function memoryAgent(
  storage: Storage,
): Promise<{ publicKey: string; privateKey: string }> {
  try {
    const stored = JSON.parse(storage.getItem(MEMORY_HOST_KEY) ?? 'null');

    if (stored?.publicKey && stored?.privateKey) return stored;
  } catch {
    // Made again below.
  }

  const pair = await generateKeyPair();

  try {
    storage.setItem(MEMORY_HOST_KEY, JSON.stringify(pair));
  } catch {
    // This page only.
  }

  return pair;
}

const SUBJECT = 'https://atomicdata.dev/properties/subject';
const LORO_UPDATE = 'https://atomicdata.dev/properties/loroUpdate';

const fromB64Url = (value: string) =>
  decodeB64(value.replace(/-/g, '+').replace(/_/g, '/'));

/**
 * A host for the embed in a browser, without an app behind it: the web app's
 * default ontology plus what the page saves, answering the same calls as the
 * Rust side.
 *
 * Without `storage` it is a sandbox for trying the embed, with a few made-up
 * resources. With `storage` (`?host=memory`: the tab's `sessionStorage`) it
 * is the store of a web demo: the resources and their Loro snapshots live in
 * that storage, so a document keeps its text when its editor closes and opens
 * again in the same tab, and the page that shows the editor (in an iframe,
 * same origin) can put the resource there first.
 */
export function createMockHost(storage?: Storage): NativeChannel & {
  resources: Map<string, JsonAd>;
} {
  const resources = new Map<string, JsonAd>();
  const snapshots = new Map<string, string>();
  /** Every call the page made, newest last: for looking at in a console. */
  const calls: Array<[string, unknown[]]> = [];
  // `did:ad:X` and `atomic:X` are one resource.
  const key = (subject: string) => subject.replace(/^(did:ad:|atomic:)/, '');

  for (const r of [
    ...(baseModels as JsonAd[]),
    ...(defaultStore as JsonAd[]),
  ]) {
    resources.set(r['@id'], r);
  }

  const save = (subject: string) => {
    if (!storage) return;

    const r = resources.get(subject);

    try {
      if (r) {
        storage.setItem(
          MEMORY_HOST_PREFIX + subject,
          JSON.stringify({
            jsonAd: r,
            snapshot: snapshots.get(subject) ?? null,
          }),
        );
      } else {
        storage.removeItem(MEMORY_HOST_PREFIX + subject);
      }
    } catch {
      // Full or blocked: the page keeps working on what it has in memory.
    }
  };

  const loadStored = () => {
    if (!storage) return;

    for (let i = 0; i < storage.length; i++) {
      const name = storage.key(i);

      if (!name?.startsWith(MEMORY_HOST_PREFIX)) continue;

      try {
        const row = JSON.parse(storage.getItem(name) ?? 'null') as {
          jsonAd?: JsonAd;
          snapshot?: string | null;
        } | null;
        const subject = name.slice(MEMORY_HOST_PREFIX.length);

        if (!row?.jsonAd) continue;

        resources.set(subject, { ...row.jsonAd, '@id': subject });

        if (row.snapshot) snapshots.set(subject, row.snapshot);
      } catch {
        // A row that is not ours: left alone.
      }
    }
  };

  // DID subjects, like real resources: the store resolves them locally.
  const drive = '';
  const folder =
    'did:ad:-HBYtYHShjXaA3WwCO5ytOeI0xAVRSeMpDPo_G2GTlCCBH5hnLCZPNEGfgkZ6lbwegdTpH3sRazAT8vtLnkSJA';
  const add = (r: JsonAd) => resources.set(r['@id'], r);

  if (!storage) {
    add({
      '@id': drive,
      [IS_A]: [DRIVE],
      [NAME]: 'Mock drive',
      [DESCRIPTION]: 'A drive that only exists in this page.',
    });
    add({
      '@id': folder,
      [IS_A]: [FOLDER],
      [NAME]: 'A folder',
      [PARENT]: drive,
    });
    add({
      '@id':
        'did:ad:mECIr9XPNTZUU7ISoThaSOEpEdDEu-TSpdMYeKqu9E42s-RLiGbb_n8vSv_AZBXRKqPgumWOxvhAQfPZYuV1OA',
      [IS_A]: ['https://atomicdata.dev/classes/Class'],
      [NAME]: 'A resource inside the folder',
      [PARENT]: folder,
      [DESCRIPTION]: 'Rendered by ResourcePage, with nothing around it.',
    });
  }

  loadStored();

  const find = (id: string) =>
    resources.get(id) ??
    [...resources.values()].find(r => key(r['@id']) === key(id));

  const snapshotOf = (id: string) => {
    const r = find(id);

    return (r && snapshots.get(r['@id'])) ?? null;
  };

  const put = (json: string, snapshot?: string | null) => {
    const r = JSON.parse(json) as JsonAd;
    const subject = find(r['@id'])?.['@id'] ?? r['@id'];

    resources.set(subject, { ...r, '@id': subject });

    if (snapshot) snapshots.set(subject, snapshot);

    save(subject);
  };

  const text = (id: string) => {
    const r = find(id);

    // Answered under the name it was asked by.
    return r ? JSON.stringify({ ...r, '@id': id }) : null;
  };

  const keys = storage ? memoryAgent(storage) : undefined;

  const signWith = async (data: Uint8Array) => {
    const pair = await keys!;

    return signBytesWithKey(data, fromB64Url(pair.privateKey));
  };

  const agentMethods: Record<string, (args: unknown[]) => unknown> = keys
    ? {
        agent: async () => `did:ad:agent:${(await keys).publicKey}`,
        publicKey: async () => (await keys).publicKey,
        sign: ([data]) => signWith(new TextEncoder().encode(data as string)),
        signBytes: ([data]) => signWith(decodeB64(data as string)),
      }
    : {};

  const applyLoro = async (commitJson: string) => {
    await enableLoro();
    const commit = JSON.parse(commitJson) as Record<string, unknown>;
    const subject = String(commit[SUBJECT] ?? '');
    const update = commit[LORO_UPDATE];

    if (!subject || typeof update !== 'string') return;

    const known = find(subject);
    const id = known?.['@id'] ?? subject;
    const doc = new LoroLoader.Loro.LoroDoc();
    const before = snapshots.get(id);

    if (before) doc.import(decodeB64(before));

    doc.import(decodeB64(update));
    snapshots.set(id, encodeB64(doc.export({ mode: 'snapshot' })));
    resources.set(id, {
      ...(known ?? {}),
      ...(doc.getMap('properties').toJSON() as Record<string, unknown>),
      '@id': id,
    });
    save(id);
  };

  const methods: Record<string, (args: unknown[]) => unknown> = {
    ...agentMethods,
    init: () => true,
    getResource: ([s]) => text(s as string),
    getResourcesWithSnapshots: ([subjects]) =>
      (subjects as string[]).map(s => ({
        jsonAd: text(s),
        snapshot: snapshotOf(s),
      })),
    getLoroSnapshot: ([s]) => snapshotOf(s as string),
    allSubjects: () => [...resources.keys()],
    getDriveSubjects: () => [...resources.keys()],
    getAllVersionVectors: () => ({}),
    getVersionVectorsForDrive: () => ({}),
    getVersionVectorsForSubjects: () => ({}),
    historyAttribution: () => null,
    getBlob: () => null,
    flush: () => undefined,
    outboxEntries: () => [],
    outboxWrite: () => undefined,
    putResource: ([j]) => put(j as string),
    putResources: ([js]) => {
      for (const j of js as string[]) put(j);
    },
    putResourceWithSnapshot: ([, j, snapshot]) =>
      put(j as string, snapshot as string | null),
    // What the Rust host does with a commit, enough for a memory store: the
    // Loro update goes into the resource's snapshot, and its properties are
    // read back from it, so the text is there when the editor opens again.
    applyCommit: ([json]) => storage && applyLoro(json as string),
    applyPeerCommit: ([json]) => storage && applyLoro(json as string),
    removeResource: ([s]) => {
      const subject = find(s as string)?.['@id'] ?? (s as string);

      resources.delete(subject);
      snapshots.delete(subject);
      save(subject);
    },
    query: ([opts]) => {
      const o = opts as { property?: string; value?: string; limit?: number };
      const subjects = [...resources.values()]
        .filter(r => {
          if (!o.property) return true;
          const v = r[o.property];

          return Array.isArray(v) ? v.includes(o.value) : v === o.value;
        })
        .map(r => r['@id'])
        .slice(0, o.limit ?? 1000);

      return { subjects, count: subjects.length, resources: [] };
    },
    search: ([q]) =>
      [...resources.values()]
        .filter(r =>
          String(r[NAME] ?? '')
            .toLowerCase()
            .includes(String(q).toLowerCase()),
        )
        .map(r => r['@id'])
        .slice(0, 20),
  };

  if (typeof window !== 'undefined') {
    Object.assign(window, { mockHostCalls: calls });
  }

  return {
    resources,
    async call(method, args) {
      calls.push([method, args]);
      const m = methods[method];

      if (!m) throw new Error(`mock host: no ${method}`);

      return m(args);
    },
  };
}
