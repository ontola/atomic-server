import { describe, expect, it } from 'vitest';
import { verify } from '@noble/ed25519';
import { Agent } from './agent.js';
import { Client } from './client.js';
import { decodeB64, encodeB64 } from './base64.js';
import { core } from './ontologies/core.js';

async function legacyAgent() {
  const keys = await Agent.generateKeyPair();
  const subject = `https://atomicdata.dev/agents/${encodeB64(decodeB64(keys.publicKey))}`;
  const agent = Agent.fromSecret(
    Agent.buildSecret(keys.privateKey, subject),
    'js',
  );

  return { agent, subject };
}

describe('reading legacy HTTP resources with a migrated agent', () => {
  it('sends the old HTTP identity and standard-base64 proof accepted by the old server', async () => {
    const { agent, subject } = await legacyAgent();
    const target = 'https://atomicdata.dev/drive/private';
    const canonicalIdentity = agent.subject;
    const client = new Client(async (input, init) => {
      const headers = new Headers(init?.headers);
      expect(headers.get('x-atomic-agent')).toBe(subject);
      const publicKey = headers.get('x-atomic-public-key')!;
      const signature = headers.get('x-atomic-signature')!;
      expect(publicKey).toBe(encodeB64(decodeB64(await agent.getPublicKey())));
      expect(signature).toMatch(/^[A-Za-z0-9+/]+==$/);
      expect(
        verify(
          decodeB64(signature),
          new TextEncoder().encode(
            `${input} ${headers.get('x-atomic-timestamp')}`,
          ),
          decodeB64(publicKey),
        ),
      ).toBe(true);

      return new Response(
        JSON.stringify({
          '@id': target,
          [core.properties.name]: 'Private legacy drive',
        }),
      );
    });
    const result = await client.fetchResourceHTTP(target, {
      signInfo: { agent, serverURL: 'https://app.atomic.place' },
    });
    expect(result.resource.error).toBeUndefined();
    expect(result.resource.subject).toBe(target);
    expect(agent.subject).toBe(canonicalIdentity);
  });

  it.each([
    'https://other.example/drive/x',
    'https://staging.atomicdata.dev/drive/x',
    'http://atomicdata.dev/drive/x',
    'https://atomicdata.dev:8443/drive/x',
    'https://atomicdata.dev.evil.example/drive/x',
  ])(
    'does not send the legacy identity outside its exact origin: %s',
    async target => {
      const { agent, subject } = await legacyAgent();
      let identity: string | null = null;
      const client = new Client(async (_input, init) => {
        identity = new Headers(init?.headers).get('x-atomic-agent');

        return new Response(JSON.stringify({ '@id': target }));
      });
      await client.fetchResourceHTTP(target, {
        signInfo: { agent, serverURL: 'https://app.atomic.place' },
      });
      expect(identity).not.toBe(subject);
    },
  );
});
