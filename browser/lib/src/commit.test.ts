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

describe('Commit signing and keys', () => {
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
    const sig = commit.signature;
    const serialized = serializeDeterministically(commit);
    expect(serialized).to.equal(serializedCommitRust);
    expect(sig).to.equal(signatureCorrect);
  });

  it('handles did:ad genesis commits correctly', async ({ expect }) => {
    const tempSubject = 'did:ad:genesis';
    const createdAt = 0;

    const commitBuilder = new CommitBuilder(tempSubject, {
      set: new Map([
        ['https://atomicdata.dev/properties/description', 'Genesis value'],
      ]),
    });
    commitBuilder.setIsGenesis(true);

    const commit = await commitBuilder.signAt(agent, createdAt);

    // Subject should match signature
    expect(commit.subject).to.equal(`did:ad:${commit.signature}`);
    expect(commit.isGenesis).toBe(true);

    // Serialization should NOT contain the subject (circular dep — subject IS the signature)
    // but SHOULD contain isGenesis so the server can verify it
    const serialized = serializeDeterministically(commit);
    const jsonCorrect = JSON.parse(serialized);
    expect(
      jsonCorrect['https://atomicdata.dev/properties/subject'],
    ).toBeUndefined();
    expect(jsonCorrect['https://atomicdata.dev/properties/isGenesis']).toBe(
      true,
    );
  });

  it('preserves DID subject and chains commits on sequential saves', async ({
    expect,
  }) => {
    const store = new Store({ serverUrl: 'https://example.com' });
    store.setServerConnected(true);
    const agentKeys = await Agent.generateKeyPair();
    const agentDID = `did:ad:agent:${agentKeys.publicKey}`;
    const agentProvider = new JSCryptoProvider(agentKeys.privateKey);
    const signingAgent = new Agent(agentProvider, agentDID);
    store.setAgent(signingAgent);

    // Mock postCommit to return a commit with a proper subject
    const postCommitSpy = vi
      .spyOn(store, 'postCommit')
      .mockImplementation(async commit => {
        const mockCommit = {
          ...commit,
          id: `https://example.com/commits/${commit.signature}`,
        } as Commit;

        return mockCommit;
      });

    // Use Resource constructor directly to avoid fetches
    const resource = new Resource('did:ad:genesis');
    resource.setStore(store);
    resource.new = true;
    await resource.set(
      'https://atomicdata.dev/properties/isA',
      ['https://atomicdata.dev/classes/Drive'],
      false,
    );
    await resource.set(
      'https://atomicdata.dev/properties/name',
      'First Save',
      false,
    );

    // First save (Genesis) — must be explicitly marked
    resource.markNextCommitAsGenesis();
    const firstCommitId = await resource.save();
    const genesisSubject = resource.subject;
    expect(genesisSubject).toMatch(/^did:ad:/);
    expect(genesisSubject).not.toBe('did:ad:genesis');
    expect(firstCommitId).toBe(
      `https://example.com/commits/${resource.appliedCommitSignatures.values().next().value}`,
    );

    // Simulate clobbering: remove lastCommit from the cached resource state.
    // (This simulates an old remote state being merged)
    resource.removeUnsafe('https://atomicdata.dev/properties/lastCommit');
    expect(
      resource.get('https://atomicdata.dev/properties/lastCommit'),
    ).toBeUndefined();

    // Second save (Update)
    // Use set with validate: false to avoid property fetches in test
    await resource.set(
      'https://atomicdata.dev/properties/description',
      'Second Save',
      false,
    );
    const secondCommitId = await resource.save();

    // The subject MUST NOT have changed
    expect(resource.subject).toBe(genesisSubject);
    expect(secondCommitId).not.toBe(firstCommitId);

    // Verify the second commit has the first one as previousCommit
    const secondCommitCall = postCommitSpy.mock.calls[1][0];
    expect(secondCommitCall.previousCommit).toBe(firstCommitId);
    expect(secondCommitCall.subject).toBe(genesisSubject);
  });

  it('exports a full genesis loroUpdate even if Loro was initialized before first save', async ({
    expect,
  }) => {
    const store = new Store({ serverUrl: 'https://example.com' });
    store.setServerConnected(true);
    const agentKeys = await Agent.generateKeyPair();
    const agentDID = `did:ad:agent:${agentKeys.publicKey}`;
    const signingAgent = new Agent(
      new JSCryptoProvider(agentKeys.privateKey),
      agentDID,
    );
    store.setAgent(signingAgent);

    const postCommitSpy = vi
      .spyOn(store, 'postCommit')
      .mockImplementation(async commit => {
        return {
          ...commit,
          id: `https://example.com/commits/${commit.signature}`,
        } as Commit;
      });

    const resource = new Resource('did:ad:genesis');
    resource.setStore(store);
    resource.new = true;
    await resource.set(
      'https://atomicdata.dev/properties/name',
      'First Save',
      false,
    );

    // Simulate UI code touching the Loro doc before the first save.
    resource.getLoroDoc();

    resource.markNextCommitAsGenesis();
    await resource.save();

    const firstCommitCall = postCommitSpy.mock.calls[0][0];
    expect(firstCommitCall.loroUpdate).toBeDefined();

    const materialized = new Resource(firstCommitCall.subject);
    materialized.importLoroUpdate(firstCommitCall.loroUpdate!);
    expect(materialized.get('https://atomicdata.dev/properties/name')).toBe(
      'First Save',
    );
  });

  it('newResource DID genesis includes parent and class metadata for folder resources', async ({
    expect,
  }) => {
    const store = new Store({ serverUrl: 'https://example.com' });
    store.setServerConnected(true);
    const agentKeys = await Agent.generateKeyPair();
    const agentDID = `did:ad:agent:${agentKeys.publicKey}`;
    const signingAgent = new Agent(
      new JSCryptoProvider(agentKeys.privateKey),
      agentDID,
    );
    store.setAgent(signingAgent);

    const postCommitSpy = vi
      .spyOn(store, 'postCommit')
      .mockImplementation(async commit => {
        return {
          ...commit,
          id: `https://example.com/commits/${commit.signature}`,
        } as Commit;
      });

    const parent = 'did:ad:drive-parent';
    const folder = await store.newResource({
      isA: core.classes.property,
      parent,
      propVals: {
        'https://atomicdata.dev/properties/name': 'Folder',
        'https://atomicdata.dev/property/display-style':
          'https://atomicdata.dev/display-styles/list',
      },
    });

    await folder.save();

    const genesisCommit = postCommitSpy.mock.calls[0][0];
    expect(genesisCommit.loroUpdate).toBeDefined();

    const materialized = new Resource(genesisCommit.subject);
    materialized.importLoroUpdate(genesisCommit.loroUpdate!);

    expect(materialized.get('https://atomicdata.dev/properties/parent')).toBe(
      parent,
    );
    expect(materialized.get('https://atomicdata.dev/properties/isA')).toEqual([
      core.classes.property,
    ]);
    expect(materialized.get('https://atomicdata.dev/properties/name')).toBe(
      'Folder',
    );
    expect(
      materialized.get('https://atomicdata.dev/property/display-style'),
    ).toBe('https://atomicdata.dev/display-styles/list');
  });

  it('drive genesis commit includes write and read arrays', async ({
    expect,
  }) => {
    const store = new Store({ serverUrl: 'https://example.com' });
    store.setServerConnected(true);
    const agentKeys = await Agent.generateKeyPair();
    const agentDID = `did:ad:agent:${agentKeys.publicKey}`;
    const signingAgent = new Agent(
      new JSCryptoProvider(agentKeys.privateKey),
      agentDID,
    );
    store.setAgent(signingAgent);

    const postCommitSpy = vi
      .spyOn(store, 'postCommit')
      .mockImplementation(async commit => {
        return {
          ...commit,
          id: `https://example.com/commits/${commit.signature}`,
        } as Commit;
      });

    // Simulate createDrive: set properties manually to avoid validation
    const resource = new Resource('_new:test-drive');
    resource.setStore(store);
    resource.new = true;
    await resource.set(
      core.properties.isA,
      ['https://atomicdata.dev/classes/Drive'],
      false,
    );
    await resource.set(
      'https://atomicdata.dev/properties/name',
      'Test Drive',
      false,
    );
    await resource.set(
      'https://atomicdata.dev/properties/write',
      [agentDID],
      false,
    );
    await resource.set(
      'https://atomicdata.dev/properties/read',
      [agentDID],
      false,
    );

    resource.markNextCommitAsGenesis();
    const drive = resource;

    await drive.save();

    const genesisCommit = postCommitSpy.mock.calls[0][0];
    expect(genesisCommit.loroUpdate).toBeDefined();

    // Materialize: import the Loro update into a fresh resource
    const materialized = new Resource(genesisCommit.subject);
    materialized.importLoroUpdate(genesisCommit.loroUpdate!);

    // The critical check: write and read arrays must be in the Loro delta
    expect(materialized.get('https://atomicdata.dev/properties/write')).toEqual(
      [agentDID],
    );
    expect(materialized.get('https://atomicdata.dev/properties/read')).toEqual([
      agentDID,
    ]);
    expect(materialized.get('https://atomicdata.dev/properties/name')).toBe(
      'Test Drive',
    );
  });

  it('saves Loro doc changes made outside set() (e.g. rich text editor)', async ({
    expect,
  }) => {
    const store = new Store({ serverUrl: 'https://example.com' });
    store.setServerConnected(true);
    const agentKeys = await Agent.generateKeyPair();
    const agentDID = `did:ad:agent:${agentKeys.publicKey}`;
    const signingAgent = new Agent(
      new JSCryptoProvider(agentKeys.privateKey),
      agentDID,
    );
    store.setAgent(signingAgent);

    const postCommitSpy = vi
      .spyOn(store, 'postCommit')
      .mockImplementation(async commit => {
        return {
          ...commit,
          id: `https://example.com/commits/${commit.signature}`,
        } as Commit;
      });

    // Create resource with a title
    const resource = new Resource('_new:test-doc');
    resource.setStore(store);
    resource.new = true;
    await resource.set(
      core.properties.isA,
      ['https://atomicdata.dev/classes/DocumentV2'],
      false,
    );
    await resource.set(
      'https://atomicdata.dev/properties/name',
      'My Doc',
      false,
    );

    // Genesis save
    resource.markNextCommitAsGenesis();
    await resource.save();
    expect(postCommitSpy).toHaveBeenCalledTimes(1);

    const firstCommit = postCommitSpy.mock.calls[0][0];
    expect(firstCommit.loroUpdate).toBeDefined();

    // Now simulate what loro-prosemirror does: modify the LoroDoc directly
    const doc = resource.getLoroDoc();
    expect(doc).toBeDefined();

    // Create a "doc" root map (like loro-prosemirror does for rich text)
    const docMap = doc!.getMap('doc');
    docMap.set('content', 'Hello world');

    // Mark dirty (this is what useLoroSync does after local updates)
    resource.markDirty();

    // The resource should now have unsaved changes
    expect(resource.hasUnsavedChanges()).toBe(true);

    // Save should succeed and produce a commit with loroUpdate
    await resource.save();
    expect(postCommitSpy).toHaveBeenCalledTimes(2);

    const secondCommit = postCommitSpy.mock.calls[1][0];
    // THIS IS THE KEY ASSERTION: the second commit must have a loroUpdate
    // containing the doc map changes
    expect(secondCommit.loroUpdate).toBeDefined();
    expect(secondCommit.loroUpdate!.length).toBeGreaterThan(4);

    // Verify the content roundtrips: import the delta into a fresh doc
    // that already has the genesis state (simulating the server's flow)
    const materialized = new Resource(secondCommit.subject);
    // First import the genesis snapshot
    materialized.importLoroUpdate(firstCommit.loroUpdate!);
    // Then import the delta
    materialized.importLoroUpdate(secondCommit.loroUpdate!);
    const importedDoc = materialized.getLoroDoc();
    const importedDocMap = importedDoc!.getMap('doc');
    expect(importedDocMap.toJSON()).toHaveProperty('content', 'Hello world');
  });

  it('derives did:ad subject from temporary _new subject', async ({
    expect,
  }) => {
    const tempSubject = '_new:01TESTTEMP';
    const createdAt = 0;
    const didAgent = new Agent(
      new JSCryptoProvider(privateKey),
      'did:ad:agent:TESTAGENT',
    );

    const commitBuilder = new CommitBuilder(tempSubject, {
      set: new Map([
        ['https://atomicdata.dev/properties/description', 'Genesis value'],
      ]),
    });
    commitBuilder.setIsGenesis(true);

    const commit = await commitBuilder.signAt(didAgent, createdAt);

    expect(commit.subject).to.equal(`did:ad:${commit.signature}`);

    const serialized = serializeDeterministically(commit);
    const jsonCorrect = JSON.parse(serialized);
    expect(
      jsonCorrect['https://atomicdata.dev/properties/subject'],
    ).toBeUndefined();
  });

  it('preserves did:ad:agent subject — never treats it as genesis', async ({
    expect,
  }) => {
    const agentDid = 'did:ad:agent:SOMEPUBLICKEY123';
    const didAgent = new Agent(new JSCryptoProvider(privateKey), agentDid);
    const createdAt = 0;

    // Editing an existing agent resource (no previousCommit yet on first edit).
    const commitBuilder = new CommitBuilder(agentDid, {
      set: new Map([['https://atomicdata.dev/properties/name', 'Alice']]),
    });

    const commit = await commitBuilder.signAt(didAgent, createdAt);

    // Subject must remain the agent DID, not become did:ad:{signature}.
    expect(commit.subject).to.equal(agentDid);

    // Serialization must include the subject (not omit it like genesis commits).
    const serialized = serializeDeterministically(commit);
    const json = JSON.parse(serialized);
    expect(json['https://atomicdata.dev/properties/subject']).to.equal(
      agentDid,
    );
  });

  it('keeps _new subject for non-did signers', async ({ expect }) => {
    const tempSubject = '_new:01TESTTEMP';
    const createdAt = 0;
    const commitBuilder = new CommitBuilder(tempSubject, {
      set: new Map([
        ['https://atomicdata.dev/properties/description', 'Regular value'],
      ]),
    });

    const commit = await commitBuilder.signAt(agent, createdAt);

    expect(commit.subject).to.equal(tempSubject);

    const serialized = serializeDeterministically(commit);
    const jsonCorrect = JSON.parse(serialized);
    expect(jsonCorrect['https://atomicdata.dev/properties/subject']).to.equal(
      tempSubject,
    );
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

describe('Store.postCommit caches commit locally', () => {
  /**
   * Regression test for the "chatroom message post triggers a
   * `GET did:ad:commit:<sig>`" trace the user observed in the WS log.
   * Path: client signs commit → POST /commit → server applies → server
   * pushes QUERY_UPDATE → UI mounts <Message> → <CommitDetail>
   * → `useResource(commitSubject)` — which used to miss the local
   * store (the online drain path didn't materialize commits as
   * Resources, only `applyPendingCommitsLocally` did) and round-trip
   * to the server for data we literally just signed.
   *
   * Contract under test: after a successful `Store.postCommit(...)`,
   * the commit's subject MUST be present in `store.resources`, and
   * MUST carry the `signer` / `createdAt` / `previousCommit` propvals
   * that <CommitDetail> reads. We mock `client.postCommit` (NOT
   * `store.postCommit`) so the new materialization step inside
   * `Store.postCommit` actually runs.
   */
  it('adds the just-posted commit to store.resources', async ({ expect }) => {
    const store = new Store({ serverUrl: 'https://example.com' });
    store.setServerConnected(true);
    const agentKeys = await Agent.generateKeyPair();
    const agentDID = `did:ad:agent:${agentKeys.publicKey}`;
    const agentProvider = new JSCryptoProvider(agentKeys.privateKey);
    const signingAgent = new Agent(agentProvider, agentDID);
    store.setAgent(signingAgent);

    // Mock the LOWER client.postCommit so Store.postCommit's
    // materialization step still runs. Capture every commit the mock
    // returns — the signature is the source of truth for the
    // commit's DID subject and we'll use it directly to look up
    // the materialized Resource (the resource's `lastCommit`
    // propval is a URL whose path-tail extraction is unreliable
    // when the signature itself contains base64 `/` characters).
    const posted: Commit[] = [];
    vi.spyOn(store['client'], 'postCommit').mockImplementation(
      async (commit: Commit) => {
        const created = {
          ...commit,
          id: `https://example.com/commits/${commit.signature}`,
        } as Commit;
        posted.push(created);

        return created;
      },
    );

    const resource = new Resource('did:ad:genesis-msg');
    resource.setStore(store);
    resource.new = true;
    await resource.set(
      core.properties.isA,
      ['https://atomicdata.dev/classes/Message'],
      false,
    );
    await resource.set(core.properties.description, 'hello chatroom', false);

    resource.markNextCommitAsGenesis();
    await resource.save();

    // Genesis save: exactly one commit is signed and posted.
    expect(posted.length).toBe(1);
    const commitDidSubject = `did:ad:commit:${posted[0].signature}`;

    expect(
      store.resources.has(commitDidSubject),
      `expected commit Resource at ${commitDidSubject} in local store after postCommit`,
    ).toBe(true);

    const commitResource = store.resources.get(commitDidSubject)!;
    expect(
      commitResource.get('https://atomicdata.dev/properties/signer'),
      'commit Resource must carry signer for <CommitDetail>',
    ).toBe(agentDID);
    expect(
      commitResource.get('https://atomicdata.dev/properties/createdAt'),
      'commit Resource must carry createdAt for <CommitDetail>',
    ).toBeTypeOf('number');
  });
});
