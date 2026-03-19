import { describe, it, vi } from 'vitest';
import {
  CommitBuilder,
  parseAndApplyCommit,
  serializeDeterministically,
} from './commit.js';
import { Store } from './store.js';
import { JSCryptoProvider } from './CryptoProvider.js';
import { Agent } from './agent.js';
import { Resource } from './resource.js';

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

    const commit = await commitBuilder.signAt(agent, createdAt);

    // Subject should match signature
    expect(commit.subject).to.equal(`did:ad:${commit.signature}`);
    expect(commit.isGenesis).toBe(true);

    // Serialization should NOT contain the subject or isGenesis
    const serialized = serializeDeterministically(commit);
    const jsonCorrect = JSON.parse(serialized);
    expect(
      jsonCorrect['https://atomicdata.dev/properties/subject'],
    ).toBeUndefined();
    expect(
      jsonCorrect['https://atomicdata.dev/properties/isGenesis'],
    ).toBeUndefined();
  });

  it('preserves DID subject and chains commits on sequential saves', async ({
    expect,
  }) => {
    const store = new Store({ serverUrl: 'https://example.com' });
    const agentKeys = await Agent.generateKeyPair();
    const agentDID = `did:ad:agent:${agentKeys.publicKey}`;
    const agentProvider = new JSCryptoProvider(agentKeys.privateKey);
    const agent = new Agent(agentProvider, agentDID);
    store.setAgent(agent);

    // Mock postCommit to return a commit with a proper subject
    const postCommitSpy = vi.spyOn(store, 'postCommit').mockImplementation(async commit => {
      return {
        id: `https://example.com/commits/${commit.signature}`,
        commit_resource: {} as any,
        resource_new: {} as any,
        resource_old: {} as any,
      };
    });

    // Use Resource constructor directly to avoid fetches
    const resource = new Resource('did:ad:genesis');
    resource.setStore(store);
    resource.new = true;
    await resource.set('https://atomicdata.dev/properties/isA', ['https://atomicdata.dev/classes/Drive'], false);
    await resource.set('https://atomicdata.dev/properties/name', 'First Save', false);

    // First save (Genesis)
    const firstCommitId = await resource.save();
    const genesisSubject = resource.subject;
    expect(genesisSubject).toMatch(/^did:ad:/);
    expect(genesisSubject).not.toBe('did:ad:genesis');
    expect(firstCommitId).toBe(`https://example.com/commits/${resource.appliedCommitSignatures.values().next().value}`);

    // Simulate clobbering: remove lastCommit property from propvals
    // (This simulates an old remote state being merged)
    resource.getPropVals().delete('https://atomicdata.dev/properties/lastCommit');
    expect(resource.get('https://atomicdata.dev/properties/lastCommit')).toBeUndefined();

    // Second save (Update)
    // Use set with validate: false to avoid property fetches in test
    await resource.set('https://atomicdata.dev/properties/description', 'Second Save', false);
    const secondCommitId = await resource.save();

    // The subject MUST NOT have changed
    expect(resource.subject).toBe(genesisSubject);
    expect(secondCommitId).not.toBe(firstCommitId);

    // Verify the second commit has the first one as previousCommit
    const secondCommitCall = postCommitSpy.mock.calls[1][0];
    expect(secondCommitCall.previousCommit).toBe(firstCommitId);
    expect(secondCommitCall.subject).toBe(genesisSubject);
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
    expect(json['https://atomicdata.dev/properties/subject']).to.equal(agentDid);
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
  const exampleCommit = `
  {
    "@id": "https://atomicdata.dev/commits/VCHGWxax6j4pPMJWelwpSHVOL+W2R2A0vjFdSpH/HhIZxE6hyaUTtPfKjgWGNhsUsQske4yHIdqc/QsQhV03DA==",
    "https://atomicdata.dev/properties/createdAt": 1627561366516,
    "https://atomicdata.dev/properties/isA": [
      "https://atomicdata.dev/classes/Commit"
    ],
    "https://atomicdata.dev/properties/set": {
      "https://atomicdata.dev/properties/description": "My new string"
    },
    "https://atomicdata.dev/properties/signature": "VCHGWxax6j4pPMJWelwpSHVOL+W2R2A0vjFdSpH/HhIZxE6hyaUTtPfKjgWGNhsUsQske4yHIdqc/QsQhV03DA==",
    "https://atomicdata.dev/properties/signer": "https://atomicdata.dev/agents/8S2U/viqkaAQVzUisaolrpX6hx/G/L3e2MTjWA83Rxk=",
    "https://atomicdata.dev/properties/subject": "https://atomicdata.dev/element/cn6ymb8s8mc"
  }`;
  it('parses and applies a Commit correctly', async ({ expect }) => {
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
