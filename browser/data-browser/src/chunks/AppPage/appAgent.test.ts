// @wc-ignore-file
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  Agent,
  JSCryptoProvider,
  server,
  type Resource,
  type Store,
} from '@tomic/react';
import { appAgentOf } from './appAgent';

const PRIVATE_KEY = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const USER_PUBLIC = 'O2onvM62pC1io6jQKm8Nc2UyFXcd4kOmOsBIoYtZ2ik';
const APP_ID = `atomic:agent:${'A'.repeat(42)}E`;
const NODE_AGENT = `atomic:agent:${'B'.repeat(42)}E`;

function fakeStore(props: Record<string, unknown>) {
  return {
    getAgent: () =>
      new Agent(
        new JSCryptoProvider(PRIVATE_KEY),
        `did:ad:agent:${USER_PUBLIC}`,
      ),
    getServerUrl: () => 'http://node.test',
    getResource: async () =>
      ({ get: (p: string) => props[p] }) as unknown as Resource,
  } as unknown as Store;
}

afterEach(() => vi.unstubAllGlobals());

describe('appAgentOf', () => {
  it("prefers an Installation's own app id and does not ask the node", async () => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);

    expect(
      await appAgentOf(
        fakeStore({ [server.properties.integrationAppAgent]: APP_ID }),
        { drive: 'did:ad:drive', app: 'did:ad:installation' },
      ),
    ).toBe(APP_ID);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('falls back to GET /app-agent for createApp apps and older Installations', async () => {
    const fetch = vi.fn(async () => Response.json({ agent: NODE_AGENT }));
    vi.stubGlobal('fetch', fetch);

    expect(
      await appAgentOf(fakeStore({}), {
        drive: 'did:ad:drive',
        app: 'did:ad:app',
      }),
    ).toBe(NODE_AGENT);
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    const parsed = new URL(url);
    expect(parsed.origin + parsed.pathname).toBe('http://node.test/app-agent');
    expect(parsed.searchParams.get('app')).toBe('did:ad:app');
    expect(parsed.searchParams.get('drive')).toBe('did:ad:drive');
    expect(
      (init.headers as Record<string, string>)['x-atomic-signature'],
    ).toBeTruthy();
  });

  it('says so when neither has an identity', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json({})),
    );

    await expect(
      appAgentOf(fakeStore({}), { drive: 'd', app: 'a' }),
    ).rejects.toThrow('no identity of its own');
  });
});
