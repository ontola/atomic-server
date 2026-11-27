import { describe, expect, it } from 'vitest';
import { Agent, JSCryptoProvider, agentSubject } from '@tomic/react';
import { OtherAgentSecretError, agentFromOwnSecret } from './verifyAgentSecret';

async function makeSecret(claimedSubject?: string) {
  const keys = await Agent.generateKeyPair();
  const subject = agentSubject(
    await new JSCryptoProvider(keys.privateKey).getPublicKey(),
  );
  const secret = btoa(
    JSON.stringify({
      privateKey: keys.privateKey,
      subject: claimedSubject ?? subject,
    }),
  );

  return { secret, subject };
}

describe('agentFromOwnSecret', () => {
  it('accepts the secret of the agent created during signup', async () => {
    const { secret, subject } = await makeSecret();
    const agent = await agentFromOwnSecret(secret, subject);
    expect(agentSubject(await agent.getPublicKey())).toBe(subject);
  });

  it('rejects a valid secret of a different agent', async () => {
    const mine = await makeSecret();
    const other = await makeSecret();
    await expect(
      agentFromOwnSecret(other.secret, mine.subject),
    ).rejects.toBeInstanceOf(OtherAgentSecretError);
  });

  it('rejects another key that claims this agent as its subject', async () => {
    const mine = await makeSecret();
    const forged = await makeSecret(mine.subject);
    await expect(
      agentFromOwnSecret(forged.secret, mine.subject),
    ).rejects.toBeInstanceOf(OtherAgentSecretError);
  });

  it('accepts a backup that names its agent by the pre-DID URL', async () => {
    const { secret, subject } = await makeSecret();
    const key = subject.slice('atomic:agent:'.length);
    const agent = await agentFromOwnSecret(
      secret,
      `https://atomicdata.dev/agents/${key}`,
    );
    expect(agentSubject(await agent.getPublicKey())).toBe(subject);
  });
});
