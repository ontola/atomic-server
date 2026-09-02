import { describe, expect, it } from 'vitest';
import { generateInviteToken } from './invites.js';
import { Agent } from './agent.js';
import { server } from './ontologies/server.js';
import { properties } from './urls.js';
import { JSCryptoProvider } from './CryptoProvider.js';

describe('invites', () => {
  it('generates a valid invite token', async () => {
    const validPrivateKey = 'CapMWIhFUT+w7ANv9oCPqrHrwZpkP2JhzF9JnyT6WcI=';
    const validSubject = 'https://atomicdata.dev/agents/test';
    const agent = new Agent(
      new JSCryptoProvider(validPrivateKey),
      validSubject,
    );
    const target = 'https://example.com/target';
    const write = true;
    const expiresAt = Date.now() + 10000;

    const tokenBase64 = await generateInviteToken(
      target,
      agent,
      write,
      expiresAt,
    );
    expect(tokenBase64).toBeDefined();

    const decoded = JSON.parse(atob(tokenBase64));
    expect(decoded[server.properties.target]).toBe(target);
    expect(decoded[server.properties.write]).toBe(write);
    expect(decoded['https://atomicdata.dev/properties/invite/expiresAt']).toBe(
      expiresAt,
    );
    expect(decoded[properties.commit.signer]).toBe(agent.subject);
    expect(decoded[properties.commit.signature]).toBeDefined();
  });
});
