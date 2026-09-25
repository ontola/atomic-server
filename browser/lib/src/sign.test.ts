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
      'kLh-mxy_lgFD6WkbIbhJANgRhyu39USL9up1zCmqU8Jmc-4rlvLZwxSlfxKTISP2BiXLSiz_5NJZrN5XpXJ_Cg';
    const serializedCommitRust =
      '{"https://atomicdata.dev/properties/createdAt":0,"https://atomicdata.dev/properties/isA":["https://atomicdata.dev/classes/Commit"],"https://atomicdata.dev/properties/set":{"https://atomicdata.dev/properties/description":"Some value","https://atomicdata.dev/properties/shortname":"someval"},"https://atomicdata.dev/properties/signature":"kLh-mxy_lgFD6WkbIbhJANgRhyu39USL9up1zCmqU8Jmc-4rlvLZwxSlfxKTISP2BiXLSiz_5NJZrN5XpXJ_Cg","https://atomicdata.dev/properties/signer":"http://localhost/agents/7LsjMW5gOfDdJzK/atgjQ1t20J/rw8MjVg6xwqm+h8U=","https://atomicdata.dev/properties/subject":"https://localhost/new_thing"}';
    // A legacy `set` commit, serialized and signed by hand: the builder only
    // produces Loro commits now, but the canonical bytes must still match Rust.
    const unsigned = {
      subject,
      set: {
        'https://atomicdata.dev/properties/description': 'Some value',
        'https://atomicdata.dev/properties/shortname': 'someval',
      },
      createdAt: 0,
      signer: agentSubject,
    };

    const signature = await agent.sign(
      serializeDeterministically({ ...unsigned }),
    );
    expect(signature).to.equal(signatureCorrect);
    expect(serializeDeterministically({ ...unsigned, signature })).to.equal(
      serializedCommitRust,
    );
  });

  it('derives an atomic: subject from the genesis signature', async ({
    expect,
  }) => {
    // Legacy `did:ad:` placeholder in; the minted subject is canonical `atomic:`.
    const commitBuilder = new CommitBuilder('did:ad:genesis', {
      loroUpdate: new Uint8Array([1, 2, 3]),
    });
    commitBuilder.setIsGenesis(true);

    const commit = await commitBuilder.signAt(agent, 0);

    // Subject IS the signature.
    expect(commit.subject).to.equal(`atomic:${commit.signature}`);
    expect(commit.isGenesis).toBe(true);

    // Serialization omits the subject (it's circular — the subject is
    // derived FROM the signature) but keeps isGenesis for the server.
    const json = JSON.parse(serializeDeterministically(commit));
    expect(json['https://atomicdata.dev/properties/subject']).toBeUndefined();
    expect(json['https://atomicdata.dev/properties/isGenesis']).toBe(true);
  });

  it('derives an atomic: subject from a temporary _new subject', async ({
    expect,
  }) => {
    const didAgent = new Agent(
      new JSCryptoProvider(privateKey),
      'did:ad:agent:TESTAGENT',
    );
    const commitBuilder = new CommitBuilder('_new:01TESTTEMP', {
      loroUpdate: new Uint8Array([1, 2, 3]),
    });
    commitBuilder.setIsGenesis(true);

    const commit = await commitBuilder.signAt(didAgent, 0);

    expect(commit.subject).to.equal(`atomic:${commit.signature}`);
    const json = JSON.parse(serializeDeterministically(commit));
    expect(json['https://atomicdata.dev/properties/subject']).toBeUndefined();
  });

  it('preserves a did:ad:agent subject — never treats it as genesis', async ({
    expect,
  }) => {
    const agentDid = 'did:ad:agent:SOMEPUBLICKEY123';
    const didAgent = new Agent(new JSCryptoProvider(privateKey), agentDid);

    const commitBuilder = new CommitBuilder(agentDid, {
      loroUpdate: new Uint8Array([1, 2, 3]),
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
      loroUpdate: new Uint8Array([1, 2, 3]),
    });

    const commit = await commitBuilder.signAt(agent, 0);

    expect(commit.subject).to.equal('_new:01TESTTEMP');
    const json = JSON.parse(serializeDeterministically(commit));
    expect(json['https://atomicdata.dev/properties/subject']).to.equal(
      '_new:01TESTTEMP',
    );
  });
});
