import { describe, it } from 'vitest';
import { CommitBuilder, serializeDeterministically } from './commit.js';
import { JSCryptoProvider } from './CryptoProvider.js';
import { Agent } from './agent.js';

/**
 * Low-level signing primitives. These legitimately exercise
 * `CommitBuilder` directly — it's the unit under test here (canonical
 * serialization, Ed25519 signatures, DID-from-signature derivation).
 *
 * This is the ONLY place `CommitBuilder` / `_new:` subjects appear in a
 * test: they are internal building blocks, not consumer API. The
 * application-facing flow (`commit.test.ts`) goes through
 * `store.newResource()` → `set()` → `save()` and never touches them.
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
