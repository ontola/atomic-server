import stringify from 'fast-json-stable-stringify';
import { Agent } from './agent.js';
import { server } from './ontologies/server.js';
import { properties } from './urls.js';

/**
 * Generates a signed, stateless invite token.
 */
export async function generateInviteToken(
  target: string,
  agent: Agent,
  write = false,
  expiresAt?: number,
): Promise<string> {
  const expires = expiresAt ?? Date.now() + 1000 * 60 * 60 * 24 * 30; // 30 days default

  const signable = {
    [server.properties.target]: target,
    [server.properties.write]: write,
    ['https://atomicdata.dev/properties/invite/expiresAt']: expires,
    [properties.commit.signer]: agent.subject,
  };

  const serialized = stringify(signable);
  const signature = await agent.sign(serialized);

  const token = {
    ...signable,
    [properties.commit.signature]: signature,
  };

  return btoa(JSON.stringify(token));
}
