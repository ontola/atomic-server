import { describe, it, vi } from 'vitest';
import {
  Commit,
  CommitBuilder,
  commitToJsonADObject,
  parseAndApplyCommit,
  serializeDeterministically,
} from './commit.js';
import { Store } from './store.js';
import { JSCryptoProvider } from './CryptoProvider.js';
import { Agent } from './agent.js';
import { Resource } from './resource.js';
import { core } from './index.js';
import { testStore } from './test-store.js';

/**
 * Low-level signing primitives. These legitimately exercise
 * `CommitBuilder` directly — it's the unit under test here (canonical
 * serialization, Ed25519 signatures, DID-from-signature derivation).
 * Application/integration tests below never touch `CommitBuilder`;
 * they go through `store.newResource()` → `set()` → `save()`.
 */
describe('Commit signing primitives', () => {
  const privateKey = 'CapMWIhFUT+w7ANv9oCPqrHrwZpkP2JhzF9JnyT6WcI=';
  const agentSubject =
    'http://localhost/agents/7LsjMW5gOfDdJzK/atgjQ1t20J/rw8MjVg6xwqm+h8U=';
  const agent = new Agent(new JSCryptoProvider(privateKey), agentSubject);
  const subject = 'https://localhost/new_thing';

  it('signs a commit with the right signature', async ({ expect }) => {
    const signatureCorrect =
      'kLh+mxy/lgFD6WkbIbhJANgRhyu39USL9up1zCmqU8Jmc+4rlvLZwxSlfxKTISP2BiXLSiz/5NJZrN5XpXJ/Cg==';
    const serializedCommitRust =
      '{"https://atomicdata.dev/properties/createdAt":0,"https://atomicdata.dev/properties/isA":["https://atomicdata.dev/classes/Commit"],"https://atomicdata.dev/properties/set":{"https://atomicdata.dev/properties/description":"Some value","https://atomicdata.dev/properties/shortname":"someval"},"https://atomicdata.dev/properties/signature":"kLh+mxy/lgFD6WkbIbhJANgRhyu39USL9up1zCmqU8Jmc+4rlvLZwxSlfxKTISP2BiXLSiz/5NJZrN5XpXJ/Cg==","https://atomicdata.dev/properties/signer":"http://localhost/agents/7LsjMW5gOfDdJzK/atgjQ1t20J/rw8MjVg6xwqm+h8U=","https://atomicdata.dev/properties/subject":"https://localhost/new_thing"}';
    const createdAt = 0;

    const commitBuilder = new CommitBuilder(subject, {
      set: new Map([
        ['https://atomicdata.dev/properties/description', 'Some value'],
        ['https://atomicdata.dev/properties/shortname', 'someval'],
      ]),
    });

    const commit = await commitBuilder.signAt(agent, createdAt);
    expect(serializeDeterministically(commit)).to.equal(serializedCommitRust);
    expect(commit.signature).to.equal(signatureCorrect);
  });

  it('derives a did:ad subject from the genesis signature', async ({
    expect,
  }) => {
    const commitBuilder = new CommitBuilder('did:ad:genesis', {
      set: new Map([
        ['https://atomicdata.dev/properties/description', 'Genesis value'],
      ]),
    });
    commitBuilder.setIsGenesis(true);

    const commit = await commitBuilder.signAt(agent, 0);

    // Subject IS the signature.
    expect(commit.subject).to.equal(`did:ad:${commit.signature}`);
    expect(commit.isGenesis).toBe(true);

    // Serialization omits the subject (it's circular — the subject is
    // derived FROM the signature) but keeps isGenesis for the server.
    const json = JSON.parse(serializeDeterministically(commit));
    expect(json['https://atomicdata.dev/properties/subject']).toBeUndefined();
    expect(json['https://atomicdata.dev/properties/isGenesis']).toBe(true);
  });

  it('derives a did:ad subject from a temporary _new subject', async ({
    expect,
  }) => {
    const didAgent = new Agent(
      new JSCryptoProvider(privateKey),
      'did:ad:agent:TESTAGENT',
    );
    const commitBuilder = new CommitBuilder('_new:01TESTTEMP', {
      set: new Map([
        ['https://atomicdata.dev/properties/description', 'Genesis value'],
      ]),
    });
    commitBuilder.setIsGenesis(true);

    const commit = await commitBuilder.signAt(didAgent, 0);

    expect(commit.subject).to.equal(`did:ad:${commit.signature}`);
    const json = JSON.parse(serializeDeterministically(commit));
    expect(json['https://atomicdata.dev/properties/subject']).toBeUndefined();
  });

  it('preserves a did:ad:agent subject — never treats it as genesis', async ({
    expect,
  }) => {
    const agentDid = 'did:ad:agent:SOMEPUBLICKEY123';
    const didAgent = new Agent(new JSCryptoProvider(privateKey), agentDid);

    const commitBuilder = new CommitBuilder(agentDid, {
      set: new Map([['https://atomicdata.dev/properties/name', 'Alice']]),
    });

    const commit = await commitBuilder.signAt(didAgent, 0);

    // Subject must remain the agent DID, not become did:ad:{signature}.
    expect(commit.subject).to.equal(agentDid);
    const json = JSON.parse(serializeDeterministically(commit));
    expect(json['https://atomicdata.dev/properties/subject']).to.equal(
      agentDid,
    );
  });

  it('keeps the _new subject for non-did signers', async ({ expect }) => {
    const commitBuilder = new CommitBuilder('_new:01TESTTEMP', {
      set: new Map([
        ['https://atomicdata.dev/properties/description', 'Regular value'],
      ]),
    });

    const commit = await commitBuilder.signAt(agent, 0);

    expect(commit.subject).to.equal('_new:01TESTTEMP');
    const json = JSON.parse(serializeDeterministically(commit));
    expect(json['https://atomicdata.dev/properties/subject']).to.equal(
      '_new:01TESTTEMP',
    );
  });
});

/**
 * The application-facing flow: create a resource, edit it, save it.
 * No `CommitBuilder`, no `markNextCommitAsGenesis`, no `_new:`
 * subjects, no `syncDirtyResources` — `save()` resolves once the
 * server has acked.
 */
describe('Resource save flow', () => {
  it('creates a DID resource and chains commits on sequential saves', async ({
    expect,
  }) => {
    const { store, postCommitSpy } = await testStore();

    const doc = await store.newResource({
      isA: 'https://atomicdata.dev/classes/Drive',
      propVals: { [core.properties.name]: 'First Save' },
      noParent: true,
    });

    const genesisSubject = doc.subject;
    expect(genesisSubject).toMatch(/^did:ad:/);
    expect(genesisSubject).not.toBe('did:ad:genesis');

    expect(await doc.save()).toBe('persisted');

    // A remote merge that drops `lastCommit` must not break chaining —
    // the resource keeps its own commit cursor.
    doc.removeUnsafe('https://atomicdata.dev/properties/lastCommit');

    await doc.set(
      'https://atomicdata.dev/properties/description',
      'Second',
      false,
    );
    expect(await doc.save()).toBe('persisted');

    // Subject is stable across saves.
    expect(doc.subject).toBe(genesisSubject);

    // Two commits, the second chained on the first.
    expect(postCommitSpy.mock.calls.length).toBe(2);
    const first = postCommitSpy.mock.calls[0][0] as Commit;
    const second = postCommitSpy.mock.calls[1][0] as Commit;
    expect(second.subject).toBe(genesisSubject);
    expect(second.previousCommit).toContain(first.signature!);
  });

  it('a no-op save returns "noop" and posts nothing', async ({ expect }) => {
    const { store, postCommitSpy } = await testStore();

    const doc = await store.newResource({
      isA: 'https://atomicdata.dev/classes/Drive',
      propVals: { [core.properties.name]: 'Doc' },
      noParent: true,
    });
    await doc.save();
    postCommitSpy.mockClear();

    expect(await doc.save()).toBe('noop');
    expect(postCommitSpy.mock.calls.length).toBe(0);
  });

  it('the genesis commit carries the full initial state', async ({
    expect,
  }) => {
    const { store, postCommitSpy, agentDID } = await testStore();

    const drive = await store.newResource({
      isA: 'https://atomicdata.dev/classes/Drive',
      noParent: true,
      propVals: {
        [core.properties.name]: 'Test Drive',
        'https://atomicdata.dev/properties/write': [agentDID],
        'https://atomicdata.dev/properties/read': [agentDID],
      },
    });
    expect(await drive.save()).toBe('persisted');

    const genesis = postCommitSpy.mock.calls[0][0] as Commit;
    expect(genesis.loroUpdate).toBeDefined();

    // Materialize the genesis bytes into a fresh resource and check the
    // full state round-trips.
    const materialized = new Resource(genesis.subject);
    materialized.importLoroUpdate(genesis.loroUpdate!);
    expect(materialized.get('https://atomicdata.dev/properties/name')).toBe(
      'Test Drive',
    );
    expect(materialized.get('https://atomicdata.dev/properties/write')).toEqual(
      [agentDID],
    );
    expect(materialized.get('https://atomicdata.dev/properties/read')).toEqual([
      agentDID,
    ]);
  });

  it('a folder genesis carries parent + class metadata', async ({ expect }) => {
    const { store, postCommitSpy } = await testStore();
    const parent = 'did:ad:drive-parent';

    const folder = await store.newResource({
      isA: core.classes.property,
      parent,
      propVals: { [core.properties.name]: 'Folder' },
    });
    expect(await folder.save()).toBe('persisted');

    const genesis = postCommitSpy.mock.calls[0][0] as Commit;
    const materialized = new Resource(genesis.subject);
    materialized.importLoroUpdate(genesis.loroUpdate!);

    expect(materialized.get('https://atomicdata.dev/properties/parent')).toBe(
      parent,
    );
    expect(materialized.get('https://atomicdata.dev/properties/isA')).toEqual([
      core.classes.property,
    ]);
    expect(materialized.get('https://atomicdata.dev/properties/name')).toBe(
      'Folder',
    );
  });

  it('saves Loro-doc changes made outside set() (e.g. the rich text editor)', async ({
    expect,
  }) => {
    const { store, postCommitSpy } = await testStore();

    const doc = await store.newResource({
      isA: 'https://atomicdata.dev/classes/DocumentV2',
      propVals: { [core.properties.name]: 'My Doc' },
      noParent: true,
    });
    expect(await doc.save()).toBe('persisted');
    expect(postCommitSpy.mock.calls.length).toBe(1);
    const genesis = postCommitSpy.mock.calls[0][0] as Commit;

    // Simulate loro-prosemirror: mutate the LoroDoc directly, then
    // signal the change the way `useLoroSync` does.
    const editorDoc = doc.getLoroDoc()!;
    editorDoc.getMap('doc').set('content', 'Hello world');
    doc.markDirty();
    expect(doc.hasUnsavedChanges()).toBe(true);

    expect(await doc.save()).toBe('persisted');
    expect(postCommitSpy.mock.calls.length).toBe(2);
    const delta = postCommitSpy.mock.calls[1][0] as Commit;
    expect(delta.loroUpdate!.length).toBeGreaterThan(4);

    // The out-of-band edit round-trips: genesis snapshot + delta.
    const materialized = new Resource(delta.subject);
    materialized.importLoroUpdate(genesis.loroUpdate!);
    materialized.importLoroUpdate(delta.loroUpdate!);
    expect(materialized.getLoroDoc()!.getMap('doc').toJSON()).toHaveProperty(
      'content',
      'Hello world',
    );
  });

  it('caches the just-saved commit locally so <CommitDetail> needs no fetch', async ({
    expect,
  }) => {
    /**
     * Regression: a chatroom message post used to trigger a
     * `GET did:ad:commit:<sig>` because the commit wasn't materialized
     * locally. After `save()`, the commit's DID subject must be present
     * in `store.resources` with the propvals <CommitDetail> reads.
     */
    const { store, posted, agentDID } = await testStore();

    const msg = await store.newResource({
      isA: 'https://atomicdata.dev/classes/Message',
      propVals: { [core.properties.description]: 'hello chatroom' },
      noParent: true,
    });
    expect(await msg.save()).toBe('persisted');

    expect(posted.length).toBe(1);
    const commitDidSubject = `did:ad:commit:${posted[0].signature}`;
    expect(store.resources.has(commitDidSubject)).toBe(true);

    const commitResource = store.resources.get(commitDidSubject)!;
    expect(commitResource.get('https://atomicdata.dev/properties/signer')).toBe(
      agentDID,
    );
    expect(
      commitResource.get('https://atomicdata.dev/properties/createdAt'),
    ).toBeTypeOf('number');
  });
});

describe('Commit parse and apply', () => {
  const store = new Store();
  it('parses and applies a loroUpdate Commit correctly', async ({ expect }) => {
    const source = new Resource('https://atomicdata.dev/element/cn6ymb8s8mc');
    await source.set(
      'https://atomicdata.dev/properties/description',
      'My new string',
      false,
    );
    const loroUpdate = source.getLoroDoc()!.export({
      mode: 'snapshot',
    });
    const exampleCommit = JSON.stringify(
      commitToJsonADObject({
        subject: source.subject,
        loroUpdate,
        signer:
          'https://atomicdata.dev/agents/8S2U/viqkaAQVzUisaolrpX6hx/G/L3e2MTjWA83Rxk=',
        createdAt: 1627561366516,
        signature:
          'VCHGWxax6j4pPMJWelwpSHVOL+W2R2A0vjFdSpH/HhIZxE6hyaUTtPfKjgWGNhsUsQske4yHIdqc/QsQhV03DA==',
      }),
    );

    parseAndApplyCommit(exampleCommit, store);
    const resource = await store.getResource(
      'https://atomicdata.dev/element/cn6ymb8s8mc',
    );
    const description = resource
      .get('https://atomicdata.dev/properties/description')!
      .toString();
    expect(description).to.equal('My new string');
  });
});

/**
 * Offline durability regressions. These assert on the OUTBOX and
 * clientDb plumbing (the contract that an offline `save()` persists
 * locally and survives a reload), so they wire a mock clientDb and
 * inspect what gets written — but the resource lifecycle still goes
 * through the public `newResource()` → `set()` → `save()` API.
 */
describe('offline persistence', () => {
  interface DbEntry {
    json: string;
    snapshot?: Uint8Array;
  }

  /** Attach an in-memory mock clientDb to a store; returns its backing map. */
  function attachMockClientDb(store: Store): Map<string, DbEntry> {
    const dbState = new Map<string, DbEntry>();
    (store as unknown as { clientDb: unknown }).clientDb = {
      isReady: true,
      isInitialized: true,
      initError: undefined,
      putResourceWithSnapshot: vi.fn(
        async (subject: string, json: string, snapshot?: Uint8Array) => {
          dbState.set(subject, { json, snapshot });
        },
      ),
      getResource: async (s: string) => dbState.get(s)?.json ?? null,
      getResourceWithSnapshot: async (s: string) => {
        const e = dbState.get(s);

        return { jsonAd: e?.json ?? null, snapshot: e?.snapshot };
      },
      getLoroSnapshot: async (s: string) => dbState.get(s)?.snapshot,
      waitForInit: async () => true,
      waitForReady: async () => true,
    };

    return dbState;
  }

  it('an offline save persists to clientDb and marks the outbox dirty', async ({
    expect,
  }) => {
    const { store } = await testStore();
    const dbState = attachMockClientDb(store);

    const doc = await store.newResource({
      isA: 'https://atomicdata.dev/classes/Folder',
      propVals: { [core.properties.name]: 'OnlineName' },
      noParent: true,
    });
    await doc.save();
    const subject = doc.subject;

    store.setServerConnected(false);
    await doc.set(
      'https://atomicdata.dev/properties/name',
      'OfflineName',
      false,
    );
    expect(await doc.save()).toBe('offline');

    expect(dbState.get(subject)?.json).toContain('OfflineName');
    expect(store.outbox.hasPending(subject)).toBe(true);
  });

  it('a stale WS update does not clobber the offline edit in clientDb', async ({
    expect,
  }) => {
    const { store } = await testStore();
    const dbState = attachMockClientDb(store);

    const doc = await store.newResource({
      isA: 'https://atomicdata.dev/classes/Folder',
      propVals: { [core.properties.name]: 'OnlineName' },
      noParent: true,
    });
    await doc.save();
    const subject = doc.subject;

    store.setServerConnected(false);
    await doc.set(
      'https://atomicdata.dev/properties/name',
      'OfflineName',
      false,
    );
    await doc.save();
    expect(dbState.get(subject)?.json).toContain('OfflineName');

    // A WS UPDATE arrives carrying the stale server state. The outbox
    // dirty bit must protect the local offline edit from being
    // overwritten in clientDb.
    const stale = new Resource(subject);
    stale.setStore(store);
    stale.applyHydratedValues(
      Object.entries({
        '@id': subject,
        [core.properties.isA]: ['https://atomicdata.dev/classes/Folder'],
        'https://atomicdata.dev/properties/name': 'OnlineName',
      }) as [string, never][],
    );
    stale.loading = false;
    stale.new = false;
    store.applyIncoming({
      subject,
      resource: stale,
      source: 'remote-incoming-update',
    });
    await Promise.resolve();

    expect(
      dbState.get(subject)?.json,
      'clientDb was overwritten with stale server state — offline edit lost',
    ).toContain('OfflineName');
  });

  it('the Loro subscriber does not mark dirty mid-edit while offline', async ({
    expect,
  }) => {
    // Regression: `pendingDirtyCount` must not rise from a bare `set()`
    // before `save()` runs `saveOffline`. Otherwise the e2e
    // `set → wait(pendingDirtyCount>0) → reload` races ahead of the
    // clientDb write and loses the edit.
    const { store } = await testStore();
    attachMockClientDb(store);

    const doc = await store.newResource({
      isA: 'https://atomicdata.dev/classes/Folder',
      propVals: { [core.properties.name]: 'Online' },
      noParent: true,
    });
    await doc.save();

    store.setServerConnected(false);
    const baseline = store.getSyncStatus().pendingDirtyCount;

    // Mutate WITHOUT saving — the subscriber must stay quiet offline.
    await doc.set(
      'https://atomicdata.dev/properties/name',
      'OfflineEdit',
      false,
    );
    expect(store.getSyncStatus().pendingDirtyCount).toBe(baseline);

    // Saving raises it.
    await doc.save();
    expect(store.getSyncStatus().pendingDirtyCount).toBeGreaterThan(baseline);
  });
});
