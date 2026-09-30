import { describe, it } from 'vitest';
import { Agent } from './agent.js';
import { decodeB64 } from './base64.js';
import { JSCryptoProvider, legacySubjectFromSecret } from './CryptoProvider.js';
import {
  AGENT_VAULT_PROOF_MESSAGE,
  privateDriveSubject,
  aiChatsFolderCert,
  verifyGenesisCert,
} from './genesis.js';
import {
  isAgentSubject,
  isAtomicIdentifier,
  canonicalizeScheme,
  toLegacyScheme,
} from './subject.js';

describe('Agent', () => {
  const validPrivateKey = 'CapMWIhFUT+w7ANv9oCPqrHrwZpkP2JhzF9JnyT6WcI=';
  const validSubject =
    'https://atomicdata.dev/agents/PLwTOXVvQdHYpaLEq5IozLNeUBdXMVchKjFwFfamBlo=';

  it('Constructs valid ', async ({ expect }) => {
    const validAgent = () =>
      new Agent(new JSCryptoProvider(validPrivateKey), validSubject);
    expect(validAgent).not.to.throw();
    // Can't get this to throw yet
    // const invalidAgentSignature = () => new Agent(validSubject, 'ugh');
    // expect(invalidAgentSignature).to.throw();
    const invalidAgentUrl = () =>
      new Agent(new JSCryptoProvider(validPrivateKey), 'not a url');
    expect(invalidAgentUrl).to.throw();
  });

  it('signs any string correctly', async ({ expect }) => {
    const agent = new Agent(
      new JSCryptoProvider(validPrivateKey),
      validSubject,
    );
    const input = 'val';
    // base64url (RFC 4648 §5, unpadded) — matches the Rust signer encoding.
    const correct_signature_rust =
      'YtDR_xo0272LHNBQtDer4LekzdkfUANFTI0eHxZhITXnbC3j0LCqDWhr6itNvo4tFnep6DCbev5OKAHH89-TDA';
    const signature = await agent.sign(input);
    expect(signature).to.equal(correct_signature_rust);
  });

  it('creates the right public key', async ({ expect }) => {
    const agent = new Agent(
      new JSCryptoProvider(validPrivateKey),
      validSubject,
    );
    const generatedPublickey = await agent.getPublicKey();
    expect(generatedPublickey).to.equal(
      '7LsjMW5gOfDdJzK_atgjQ1t20J_rw8MjVg6xwqm-h8U',
    );
  });

  it('derives a stable personal-drive DID from the key', async ({ expect }) => {
    const agent = new Agent(
      new JSCryptoProvider(validPrivateKey),
      validSubject,
    );
    const first = await agent.privateDriveSubject();
    const second = await agent.privateDriveSubject();
    expect(first).toBe(second);
    expect(first).toBe(await privateDriveSubject(decodeB64(validPrivateKey)));
    expect(isAtomicIdentifier(first)).toBe(true);
    expect(isAgentSubject(first)).toBe(false);
  });

  /**
   * The vault proof is key material: `agent_secret_kek` on the server derives
   * the key that wraps a drive's vault key from it. So it must be the RFC 8032
   * deterministic signature — the one a `js` agent produces — regardless of
   * which provider the agent ends up with, and it must survive re-derivation.
   */
  it('derives the vault proof deterministically from the secret', async ({
    expect,
  }) => {
    const secret = Agent.buildSecret(validPrivateKey, validSubject);
    const jsAgent = Agent.fromSecret(secret, 'js');

    const fromSecret = await Agent.vaultProofFromSecret(secret);
    expect(fromSecret).toBe(await Agent.vaultProofFromSecret(secret));
    expect(fromSecret).toBe(
      await jsAgent.signBytes(AGENT_VAULT_PROOF_MESSAGE),
    );
    expect(decodeB64(fromSecret)).toHaveLength(64);
  });
});

describe('legacySubjectFromSecret', () => {
  const b64 = (o: unknown) => btoa(JSON.stringify(o));

  it('recovers the pre-DID subject, which only the secret still knows', ({
    expect,
  }) => {
    const pk = 'QmfpRIBn2JYEatT0MjSkMNoBJzstz19orwnT5oT2rcQ=';
    expect(
      legacySubjectFromSecret(
        b64({
          privateKey: 'x',
          subject: `https://atomicdata.dev/agents/${pk}`,
        }),
      ),
    ).toBe(`https://atomicdata.dev/agents/${pk}`);
    // http and a port, as a self-hosted pre-DID server would have issued.
    expect(
      legacySubjectFromSecret(
        b64({ privateKey: 'x', subject: `http://localhost:9883/agents/${pk}` }),
      ),
    ).toBe(`http://localhost:9883/agents/${pk}`);
  });

  it('returns undefined for a modern secret', ({ expect }) => {
    // The DID is derivable from the key, so there is nothing to recover.
    expect(
      legacySubjectFromSecret(
        b64({ privateKey: 'x', subject: 'did:ad:agent:NkQ5OoxIzOnKu5Oa' }),
      ),
    ).toBeUndefined();
  });

  it('never throws on a malformed secret', ({ expect }) => {
    // Runs on the sign-in path — it must not be able to break signing in.
    for (const bad of [
      '',
      'not-base64!!',
      btoa('{'),
      btoa('{}'),
      btoa('null'),
    ]) {
      expect(() => legacySubjectFromSecret(bad)).not.toThrow();
      expect(legacySubjectFromSecret(bad)).toBeUndefined();
    }
  });
});

describe('AI chat folder identity', () => {
  const key = 'CapMWIhFUT+w7ANv9oCPqrHrwZpkP2JhzF9JnyT6WcI=';
  const secret = Agent.buildSecret(key, 'did:ad:agent:test');

  it('converges across independent devices, scoped by drive and account', async ({
    expect,
  }) => {
    const phone = Agent.fromSecret(secret, 'js');
    const desktop = Agent.fromSecret(secret, 'js');
    const drive = await phone.privateDriveSubject();
    const [a, b] = await Promise.all([
      phone.aiChatsFolderSubject(drive),
      desktop.aiChatsFolderSubject(drive),
    ]);
    expect(a).toBe(b);
    expect(
      await verifyGenesisCert(
        aiChatsFolderCert(decodeB64(await phone.getPublicKey()), drive),
        a.slice('did:ad:'.length),
      ),
    ).toBe(true);
    expect(await phone.aiChatsFolderSubject('did:ad:other-drive')).not.toBe(a);
    const other = Agent.fromSecret(
      Agent.buildSecret(
        'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
        'did:ad:agent:other',
      ),
      'js',
    );
    expect(await other.aiChatsFolderSubject(drive)).not.toBe(a);
    expect((await Agent.aiChatsFoldersFromSecret(secret))[drive]).toBe(a);
  });

  it('restores stable identities without signing with a randomized provider', async ({
    expect,
  }) => {
    const provider = new JSCryptoProvider(key);
    const restored = new Agent({
      type: 'test',
      signsDeterministically: false,
      getPublicKey: () => provider.getPublicKey(),
      sign: () => {
        throw new Error('Must not sign');
      },
      signBytes: () => {
        throw new Error('Must not sign');
      },
    });
    const identities = await Agent.aiChatsFoldersFromSecret(secret);
    const drive = Object.keys(identities)[0];
    await expect(restored.aiChatsFolderSubject(drive)).rejects.toThrow(
      'Sign in again',
    );
    restored.aiChatsFolders = JSON.parse(JSON.stringify(identities));
    expect(await restored.aiChatsFolderSubject(drive)).toBe(identities[drive]);
  });
});

// Upgrades must keep the singleton's signed bytes, not merely alias its prefix.
it('preserves AI Chats identity and cached aliases across the scheme upgrade', async ({
  expect,
}) => {
  const key = 'CapMWIhFUT+w7ANv9oCPqrHrwZpkP2JhzF9JnyT6WcI=';
  const agent = Agent.fromSecret(
    Agent.buildSecret(key, 'did:ad:agent:test'),
    'js',
  );
  const drive = await agent.privateDriveSubject();
  const oldFolder = await agent.aiChatsFolderSubject(toLegacyScheme(drive));
  const newFolder = await agent.aiChatsFolderSubject(canonicalizeScheme(drive));
  expect(newFolder).toBe(oldFolder);
  expect(newFolder).toBe(
    'atomic:wFAe8DFL7gZoSR0bAzaw1XnlRE5l6aYkIHNvN7uiy_9uPRQu3WieNZPJPkVBvW28zyZs9DdkAe9TVj-NLtNbBg',
  );
  // A restored non-extractable session can only use its persisted cache.
  const restored = await Agent.fromSecret(
    Agent.buildSecret(key, 'did:ad:agent:test'),
  );
  restored.aiChatsFolders = {
    [toLegacyScheme(drive)]: toLegacyScheme(oldFolder),
  };
  expect(await restored.aiChatsFolderSubject(drive)).toBe(oldFolder);
});
