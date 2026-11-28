import { Agent, agentSubject, decodeSecret } from '@tomic/react';
import {
  agentPublicKey,
  canonicalIdentifier,
  currentAgentSubject,
} from '@tomic/lib';

/** Whether `value` parses as an agent secret (no key is imported). */
export function isAgentSecret(value: string): boolean {
  try {
    decodeSecret(value.trim());

    return true;
  } catch {
    return false;
  }
}

/**
 * Whether two agent subjects name the same key. Backups spell one agent as
 * `did:ad:agent:` or `atomic:agent:`, as the pre-DID `https://server/agents/{key}`
 * URL, and with the key in base64 or base64url, padded or not.
 */
export function sameAgentKey(a: string, b: string): boolean {
  const keyOf = (subject: string) => {
    const canonical = canonicalIdentifier(currentAgentSubject(subject));

    return (agentPublicKey(canonical) ?? canonical)
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');
  };

  return keyOf(a) === keyOf(b);
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

  if (!sameAgentKey(derived, expectedSubject)) {
    throw new OtherAgentSecretError();
  }

  return agent;
}
