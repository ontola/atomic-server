import { describe, expect, it } from 'vitest';
import { Agent } from './agent.js';
import { JSCryptoProvider } from './CryptoProvider.js';
import { Client, isOwnServerUrl } from './client.js';
import { core } from './ontologies/core.js';

/**
 * ontola/atomic-server#1837: signing adds `x-atomic-*` headers, which are not
 * CORS-safelisted, so a signed GET to another origin needs a preflight.
 * GitHub Pages answers that preflight with 405, and the vocabulary fetch fails.
 */

const SERVER = 'https://app.atomic.place';

async function makeAgent(): Promise<Agent> {
  const keys = await Agent.generateKeyPair();

  return new Agent(
    new JSCryptoProvider(keys.privateKey),
    `did:ad:agent:${keys.publicKey}`,
  );
}

/** Fetches `subject` signed as a fresh agent; returns the headers sent. */
async function headersSentFor(subject: string): Promise<Headers> {
  const agent = await makeAgent();
  let sent: Headers | undefined;
  const client = new Client(async (_input, init) => {
    sent = new Headers(init?.headers);

    return new Response(
      JSON.stringify({ '@id': subject, [core.properties.name]: 'Term' }),
    );
  });
  const { resource } = await client.fetchResourceHTTP(subject, {
    signInfo: { agent, serverURL: SERVER },
    serverURL: SERVER,
  });
  expect(resource.error).toBeUndefined();

  return sent!;
}

/** True when a browser could send these headers without a CORS preflight. */
function isPreflightFree(headers: Headers): boolean {
  const safelisted = ['accept', 'accept-language', 'content-language'];

  return [...headers.keys()].every(name => safelisted.includes(name));
}

describe('cross-origin vocabulary fetches', () => {
  it.each([
    'https://ontola.github.io/atomic-plugins/ontology/classes/draft',
    'https://ontola.github.io/atomic-plugins/ontology/properties/title',
    'https://other-server.example/classes/Thing',
    // Looks like a subdomain, is not.
    'https://app.atomic.place.evil.example/classes/Thing',
    // Same host, other port or scheme: another origin.
    'https://app.atomic.place:8443/classes/Thing',
    'http://app.atomic.place/classes/Thing',
  ])('sends a plain GET without signature headers: %s', async subject => {
    const headers = await headersSentFor(subject);
    expect(headers.get('x-atomic-signature')).toBeNull();
    expect(headers.get('x-atomic-agent')).toBeNull();
    expect(headers.get('x-atomic-public-key')).toBeNull();
    expect(headers.get('x-atomic-timestamp')).toBeNull();
    expect(isPreflightFree(headers)).toBe(true);
  });

  it.each([
    `${SERVER}/drive/private`,
    // A drive served on its own subdomain of the server.
    'https://mydrive.app.atomic.place/notes/1',
  ])('still signs a request to the own server: %s', async subject => {
    const headers = await headersSentFor(subject);
    expect(headers.get('x-atomic-signature')).toBeTruthy();
    expect(headers.get('x-atomic-agent')).toMatch(/^did:ad:agent:/);
  });

  it('still signs a DID, which resolves through the own server', async () => {
    const agent = await makeAgent();
    let url = '';
    let sent: Headers | undefined;
    const client = new Client(async (input, init) => {
      url = String(input);
      sent = new Headers(init?.headers);

      return new Response(JSON.stringify({ '@id': 'did:ad:abc' }));
    });
    await client.fetchResourceHTTP('did:ad:abc', {
      signInfo: { agent, serverURL: SERVER },
      serverURL: SERVER,
    });
    expect(url.startsWith(`${SERVER}/resource?`)).toBe(true);
    expect(sent!.get('x-atomic-signature')).toBeTruthy();
  });
});

describe('isOwnServerUrl', () => {
  it('matches the server origin and its subdomains only', () => {
    expect(isOwnServerUrl(`${SERVER}/x`, SERVER)).toBe(true);
    expect(isOwnServerUrl(`${SERVER}/x`, `${SERVER}/`)).toBe(true);
    expect(isOwnServerUrl('https://d.app.atomic.place/x', SERVER)).toBe(true);
    expect(isOwnServerUrl('https://atomic.place/x', SERVER)).toBe(false);
    expect(isOwnServerUrl('https://xapp.atomic.place/x', SERVER)).toBe(false);
    expect(isOwnServerUrl('https://ontola.github.io/x', SERVER)).toBe(false);
    expect(isOwnServerUrl('https://ontola.github.io/x', undefined)).toBe(false);
    expect(
      isOwnServerUrl('http://d.localhost:9883/x', 'http://localhost:9883'),
    ).toBe(true);
    expect(
      isOwnServerUrl('http://d.localhost:9884/x', 'http://localhost:9883'),
    ).toBe(false);
  });
});
