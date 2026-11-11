import { beforeAll, describe, expect, it } from 'vitest';
import { Agent } from './agent.js';
import { classId } from './class-identity.js';
import { JSCryptoProvider } from './CryptoProvider.js';
import { LoroLoader } from './loro-loader.js';
import { core } from './ontologies/core.js';
import { propertyId } from './property-identity.js';
import { Resource } from './resource.js';
import { Store } from './store.js';

/**
 * A Property or Class subject is the hash of its own fields. A server or peer
 * that delivers a resource under such a subject with other fields is refused,
 * whatever the transport (`applyIncoming` is the one ingress).
 */

const ONTOLOGY = 'atomic:ontologyGenesis';
const STRING = 'https://atomicdata.dev/datatypes/string';
const NAME = propertyId(ONTOLOGY, 'name', STRING);

const CLASS_ID = classId(ONTOLOGY, 'task', [NAME]);
const PROP_ID = propertyId(ONTOLOGY, 'name', STRING);

const classFields = {
  [core.properties.parent]: ONTOLOGY,
  [core.properties.shortname]: 'task',
  [core.properties.requires]: [NAME],
};
const propFields = {
  [core.properties.parent]: ONTOLOGY,
  [core.properties.shortname]: 'name',
  [core.properties.datatype]: STRING,
};

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

function placeholder(store: Store, subject: string): Resource {
  const r = new Resource(subject);
  r.setStore(store);
  r.loading = true;
  store.resources.set(subject, r);

  return r;
}

const cases = [
  ['class', CLASS_ID, classFields],
  ['property', PROP_ID, propFields],
] as const;

describe.each(cases)('applyIncoming of an atomic:%s: subject', (_k, id, ok) => {
  it('applies state that hashes to the subject (Loro bytes)', async () => {
    const store = await makeStore();
    placeholder(store, id);

    expect(
      store.applyIncoming({
        subject: id,
        loroBytes: snapshotWith(ok),
        source: 'ws-pending-get',
        replaceLoroDocsFromRemote: true,
      }),
    ).toBe('applied');

    const got = store.resources.get(id)!;
    expect(got.error).toBeUndefined();
    expect(got.loading).toBe(false);
    expect(got.get(core.properties.shortname)).toBe(
      ok[core.properties.shortname],
    );
  });

  it.each(['ws-pending-get', 'ws-sub-push', 'peer-sync'] as const)(
    'refuses state that does not hash to the subject (%s)',
    async source => {
      const store = await makeStore();
      placeholder(store, id);

      const result = store.applyIncoming({
        subject: id,
        loroBytes: snapshotWith({
          ...ok,
          [core.properties.shortname]: 'tampered',
        }),
        source,
      });

      expect(result).toBe('invalid');

      const got = store.resources.get(id)!;
      expect(got.error?.message).toMatch(/mismatch/i);
      expect(got.loading).toBe(false);
    },
  );

  it('refuses a parsed resource that does not hash to the subject (http-fetch)', async () => {
    const store = await makeStore();
    placeholder(store, id);
    const bad = new Resource(id);
    bad.setStore(store);
    await bad.set(core.properties.parent, ONTOLOGY);
    await bad.set(core.properties.shortname, 'tampered');
    await bad.set(core.properties.datatype, STRING);

    expect(
      store.applyIncoming({ subject: id, resource: bad, source: 'http-fetch' }),
    ).toBe('invalid');
    expect(store.resources.get(id)!.error?.message).toMatch(/mismatch|usable/i);
  });

  it('does not check state this client wrote itself', async () => {
    const store = await makeStore();
    const local = new Resource(id);
    local.setStore(store);
    await local.set(core.properties.shortname, 'tampered');

    expect(
      store.applyIncoming({
        subject: id,
        resource: local,
        source: 'local-post',
      }),
    ).toBe('applied');
  });

  it('keeps a good copy it already holds when a bad update arrives', async () => {
    const store = await makeStore();
    placeholder(store, id);
    store.applyIncoming({
      subject: id,
      loroBytes: snapshotWith(ok),
      source: 'ws-pending-get',
      replaceLoroDocsFromRemote: true,
    });

    const bad = new Resource(id);
    bad.setStore(store);
    await bad.set(core.properties.shortname, 'tampered');

    expect(
      store.applyIncoming({ subject: id, resource: bad, source: 'http-fetch' }),
    ).toBe('invalid');

    const got = store.resources.get(id)!;
    expect(got.error).toBeUndefined();
    expect(got.get(core.properties.shortname)).toBe(
      ok[core.properties.shortname],
    );
  });
});

describe('applyIncoming of other subjects', () => {
  it('does not verify an ordinary resource', async () => {
    const store = await makeStore();
    const subject = 'atomic:someOrdinaryResourceAAAAAAAAAAAAAAAAAAAAAAAAA==';
    placeholder(store, subject);

    expect(
      store.applyIncoming({
        subject,
        loroBytes: snapshotWith({ [core.properties.shortname]: 'whatever' }),
        source: 'ws-pending-get',
      }),
    ).toBe('applied');
  });
});

describe('class requires', () => {
  it('a class with no requires hashes an empty set', async () => {
    const store = await makeStore();
    const id = classId(ONTOLOGY, 'empty');
    placeholder(store, id);

    expect(
      store.applyIncoming({
        subject: id,
        loroBytes: snapshotWith({
          [core.properties.parent]: ONTOLOGY,
          [core.properties.shortname]: 'empty',
        }),
        source: 'ws-pending-get',
        replaceLoroDocsFromRemote: true,
      }),
    ).toBe('applied');
  });

  it('ignores recommends, which are outside the hash', async () => {
    const store = await makeStore();
    placeholder(store, CLASS_ID);

    expect(
      store.applyIncoming({
        subject: CLASS_ID,
        loroBytes: snapshotWith({
          ...classFields,
          [core.properties.recommends]: [propertyId(ONTOLOGY, 'x', STRING)],
          [core.properties.description]: 'any text',
        }),
        source: 'ws-pending-get',
        replaceLoroDocsFromRemote: true,
      }),
    ).toBe('applied');
  });
});
