import { Agent, agentSubject } from '@tomic/react';

/** Thrown when a valid secret belongs to another agent than the expected one. */
export class OtherAgentSecretError extends Error {
  constructor() {
    super(
      'This secret belongs to a different agent. Paste the secret you just saved for this account.',
    );
    this.name = /* @wc-ignore */ 'OtherAgentSecretError';
  }
}

/**
 * Parse `secret` and check that its key is the one of `expectedSubject`.
 *
 * Compares the agent derived from the secret's public key, not the subject the
 * secret claims: that field is free text inside the secret.
 */
export async function agentFromOwnSecret(
  secret: string,
  expectedSubject: string,
): Promise<Agent> {
  const agent = await Agent.fromSecret(secret);
  const derived = agentSubject(await agent.getPublicKey());

  if (derived !== expectedSubject) {
    throw new OtherAgentSecretError();
  }

  return agent;
}
