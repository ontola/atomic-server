import stringify from 'fast-json-stable-stringify';
import { verify } from '@noble/ed25519';
import { decodeB64 } from './base64.js';
import { currentAgentSubject, agentPublicKey } from './subject.js';
import { Agent } from './agent.js';
import { server } from './ontologies/server.js';
import { core } from './ontologies/core.js';
import { properties } from './urls.js';

const REDEEM_AT = 'https://atomicdata.dev/properties/invite/redeemAt';

function invitationOrigin(raw: string): string {
  const url = new URL(raw);
  const local =
    ['localhost', '[::1]'].includes(url.hostname) ||
    /^127(?:\.\d+){3}$/.test(url.hostname);
  if (
    !(url.protocol === 'https:' || (local && url.protocol === 'http:')) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== '/'
  )
    throw new Error('Invalid invitation server origin');

  return url.origin;
}

/** Verify the signed destination before giving a node the bearer credential. */
export function verifiedInviteServer(token: string): string | undefined {
  const data = JSON.parse(atob(token));
  const raw = data[REDEEM_AT];
  if (raw === undefined) return undefined;
  const key = agentPublicKey(
    currentAgentSubject(data[properties.commit.signer]),
  );
  const signature = data[properties.commit.signature];
  delete data[properties.commit.signature];
  if (
    !key ||
    typeof raw !== 'string' ||
    typeof signature !== 'string' ||
    !verify(
      decodeB64(signature),
      new TextEncoder().encode(stringify(data)),
      decodeB64(key),
    )
  )
    throw new Error('Invalid invitation signature');

  return invitationOrigin(raw);
}

/**
 * Generates a signed, stateless invite token.
 *
 * `description` is an optional free-text note the inviter adds (e.g. "come
 * review the Q3 plan"). Included in the signed payload so recipients see
 * exactly what the inviter wrote.
 *
 * `maxUsages` limits how many different agents may accept the invite. The
 * server enforces it (it is part of the signed payload, so it cannot be
 * raised afterwards). Omit it for an unlimited invite. Invites that never
 * reach a server (`browserPeer`) cannot be limited.
 */
export async function generateInviteToken(
  target: string,
  agent: Agent,
  write = false,
  expiresAt?: number,
  description?: string,
  browserPeer = false,
  maxUsages?: number,
  serverOrigin?: string,
): Promise<string> {
  if (
    maxUsages !== undefined &&
    (!Number.isSafeInteger(maxUsages) || maxUsages < 1)
  )
    throw new Error(
      'The usage limit of an invite must be a whole number of at least 1.',
    );

  if (maxUsages !== undefined && browserPeer)
    throw new Error(
      'Invites to a drive that syncs between browsers cannot have a usage limit.',
    );

  const expires = expiresAt ?? Date.now() + 1000 * 60 * 60 * 24 * 30; // 30 days default

  const signable: Record<string, unknown> = {
    [server.properties.target]: target,
    [server.properties.write]: write,
    ['https://atomicdata.dev/properties/invite/expiresAt']: expires,
    [properties.commit.signer]: agent.subject,
  };

  // Only include the description key when actually set — keeps old tokens
  // (without description) deterministically serializing the same way.
  if (description && description.trim().length > 0) {
    signable[core.properties.description] = description.trim();
  }

  if (maxUsages !== undefined)
    signable[server.properties.usagesLeft] = maxUsages;

  if (serverOrigin) {
    const origin = invitationOrigin(serverOrigin);
    if (
      browserPeer ||
      (/^https?:/i.test(target) && new URL(target).origin !== origin)
    )
      throw new Error('Open this resource on its own server before sharing it');
    signable[REDEEM_AT] = origin;
  }

  if (browserPeer)
    signable['https://atomicdata.dev/properties/invite/transport'] = 'webrtc';

  const serialized = stringify(signable);
  const signature = await agent.sign(serialized);

  const token = {
    ...signable,
    [properties.commit.signature]: signature,
  };

  return btoa(JSON.stringify(token));
}
