import { describe, it } from 'vitest';
import {
  CommitBuilder,
  parseAndApplyCommit,
  serializeDeterministically,
} from './commit.js';
import { Store } from './store.js';
import { JSCryptoProvider } from './CryptoProvider.js';
import { Agent } from './agent.js';

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
    const tempSubject = 'did:ad:temp';
    const createdAt = 0;

    const commitBuilder = new CommitBuilder(tempSubject, {
      set: new Map([
        ['https://atomicdata.dev/properties/description', 'Genesis value'],
      ]),
    });

    const commit = await commitBuilder.signAt(agent, createdAt);

    // Subject should match signature
    expect(commit.subject).to.equal(`did:ad:${commit.signature}`);

    // Serialization should NOT contain the subject
    const serialized = serializeDeterministically(commit);
    const jsonCorrect = JSON.parse(serialized);
    expect(
      jsonCorrect['https://atomicdata.dev/properties/subject'],
    ).toBeUndefined();
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
