import { Agent, agentSubject, decodeSecret } from '@tomic/react';
import { canonicalIdentifier, currentAgentSubject } from '@tomic/lib';

/** Whether `value` parses as an agent secret (no key is imported). */
export function isAgentSecret(value: string): boolean {
  try {
    decodeSecret(value.trim());

    return true;
  } catch {
    return false;
  }
}

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
 * secret claims: that field is free text inside the secret. Legacy spellings
 * of the same agent count as equal.
 */
export async function agentFromOwnSecret(
  secret: string,
  expectedSubject: string,
): Promise<Agent> {
  const agent = await Agent.fromSecret(secret);
  const derived = agentSubject(await agent.getPublicKey());

  // A backup saved by an old account names its agent as the pre-DID
  // `https://server/agents/{key}` URL: the same key, another spelling.
  const expected = canonicalIdentifier(currentAgentSubject(expectedSubject));

  if (canonicalIdentifier(derived) !== expected) {
    throw new OtherAgentSecretError();
  }

  return agent;
}
