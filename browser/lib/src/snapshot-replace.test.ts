import { beforeAll, describe, expect, it } from 'vitest';
import { Store } from './store.js';
import { Agent } from './agent.js';
import { JSCryptoProvider } from './CryptoProvider.js';
import { LoroLoader } from './loro-loader.js';
import { Resource } from './resource.js';
import { collections, core } from './index.js';

/**
 * A WS GET response carries the SNAPSHOT flag = authoritative FULL state. The
 * client used to MERGE it into whatever Loro doc the resource already had. When
 * a SUB push had seeded that doc with PARTIAL state first, the merge could
 * surface only the seed's props — the resource rendered class-less (the user's
 * "deeply broken drive"). `applyIncoming({ replaceLoroDocsFromRemote })` now
 * REPLACES the doc for snapshot GET responses, so the full state wins.
 */

const PARENT = 'https://atomicdata.dev/properties/parent';
const NAME = 'https://atomicdata.dev/properties/name';
const DRIVE = 'https://atomicdata.dev/classes/Drive';

beforeAll(async () => {
  await LoroLoader.initializeLoro();
});

async function makeStore(): Promise<Store> {
  const store = new Store({ serverUrl: 'https://example.com' });
  const keys = await Agent.generateKeyPair();
  store.setAgent(
    new Agent(
      new JSCryptoProvider(keys.privateKey),
      `did:ad:agent:${keys.publicKey}`,
    ),
  );

  return store;
}

function snapshotWith(props: Record<string, unknown>): Uint8Array {
  const { LoroDoc } = LoroLoader.Loro;
  const doc = new LoroDoc();
  const map = doc.getMap('properties');

  for (const [k, v] of Object.entries(props)) map.set(k, v);

  doc.commit();

  return doc.export({ mode: 'snapshot' });
}

describe('applyIncoming — a SNAPSHOT GET response replaces a partial seed', () => {
  // Canonical spelling: the test seeds `store.resources` directly, and that
  // Map is keyed by `atomic:`.
  const subject = 'atomic:driveSnapshotReplaceReproAAAAAAAAAAAAAAAAAAAAAA==';

  it('surfaces the full class after replacing a class-less seeded doc', async () => {
    const store = await makeStore();
    const r = new Resource(subject);
    r.setStore(store);
    r.loading = true;
    (store as unknown as { resources: Map<string, Resource> }).resources.set(
      subject,
      r,
    );

    // 1. SUB push seeds a PARTIAL doc — only `parent`, no class.
    store.applyIncoming({
      subject,
      loroBytes: snapshotWith({ [PARENT]: 'did:ad:somedrive' }),
      source: 'ws-sub-push',
    });
    expect(
      store.resources.get(subject)?.get(core.properties.isA),
    ).toBeUndefined();

    // 2. GET response: authoritative FULL snapshot, independent doc, replace.
    store.applyIncoming({
      subject,
      loroBytes: snapshotWith({
        [core.properties.isA]: [DRIVE],
        [NAME]: 'My Drive',
        [PARENT]: 'did:ad:somedrive',
      }),
      source: 'ws-pending-get',
      replaceLoroDocsFromRemote: true,
    });

    const got = store.resources.get(subject);
    expect(got?.loading).toBe(false);
    expect(got?.error).toBeUndefined();
    expect(got?.get(core.properties.isA)).toEqual([DRIVE]);
    expect(got?.get(NAME)).toBe('My Drive');
  });
});

describe('computed collection responses', () => {
  it.each(['ws-pending-get', 'http-fetch'] as const)(
    'takes the latest members from %s even when an earlier answer wins a CRDT tie',
    source => {
      const store = new Store({
        serverUrl: 'https://example.com',
        connect: false,
      });
      const subject = 'https://example.com/query?property=parent';
      const { members, totalMembers } = collections.properties;

      function answer(peer: number, rows: string[]) {
        const doc = new LoroLoader.Loro.LoroDoc();
        doc.setPeerId(peer);
        const props = doc.getMap('properties');
        props.set(core.properties.isA, [collections.classes.collection]);
        props.set(members, rows);
        props.set(totalMembers, rows.length);
        const bytes = doc.export({ mode: 'snapshot' });

        if (source === 'http-fetch') {
          const resource = new Resource(subject);
          resource.importLoroUpdate(bytes, true);
          resource.loading = false;
          store.applyIncoming({ subject, source, resource });
        } else {
          store.applyIncoming({
            subject,
            source,
            loroBytes: bytes,
            replaceLoroDocsFromRemote: true,
            commitId: 'atomic:commit:query-definition',
          });
        }
      }

      answer(90, []);
      answer(10, ['atomic:chat-log']);
      expect(store.resources.get(subject)?.get(members)).toEqual([
        'atomic:chat-log',
      ]);
      expect(store.resources.get(subject)?.get(totalMembers)).toBe(1);
      answer(5, []);
      expect(store.resources.get(subject)?.get(members)).toEqual([]);
    },
  );
});
