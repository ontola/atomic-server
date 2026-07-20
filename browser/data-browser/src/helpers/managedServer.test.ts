import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  accountCreationTarget,
  forgetServerPeer,
  type ManagedInfo,
} from './managedServer';

// The real one needs a keypair and WebCrypto; what matters here is that the
// exact URL being fetched is what gets signed, since the server rebuilds that
// URL to verify the signature.
vi.mock('@tomic/react', () => ({
  signRequest: vi.fn(async (url: string) => ({ 'x-atomic-signed-url': url })),
}));

describe('accountCreationTarget', () => {
  it('managed node with a portal URL → the managed portal', () => {
    const info: ManagedInfo = {
      managed: true,
      portalUrl: 'https://portal.example/',
    };

    expect(accountCreationTarget(info)).toEqual({
      kind: 'portal',
      url: 'https://portal.example/',
    });
  });

  it('self-hosted / FOSS node → local identity (keeps the FOSS UX)', () => {
    expect(accountCreationTarget({ managed: false, portalUrl: null })).toEqual({
      kind: 'local',
    });
  });

  it('managed but without a portal URL → local (no portal to send to)', () => {
    expect(accountCreationTarget({ managed: true, portalUrl: null })).toEqual({
      kind: 'local',
    });
  });

  it('a portal URL present but not managed → local', () => {
    expect(
      accountCreationTarget({
        managed: false,
        portalUrl: 'https://portal.example/',
      }),
    ).toEqual({ kind: 'local' });
  });
});

describe('forgetServerPeer', () => {
  const AGENT = { subject: 'did:ad:agent:abc' } as never;
  const NODE = `did:ad:node:${'a'.repeat(64)}`;

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  function stubFetch(response: Partial<Response>) {
    const mock = vi.fn().mockResolvedValue(response as Response);
    globalThis.fetch = mock as unknown as typeof fetch;

    return mock;
  }

  it('posts the node as a query parameter, signing the exact URL', async () => {
    const fetchMock = stubFetch({ ok: true });

    await expect(
      forgetServerPeer('http://localhost:9883', NODE, AGENT),
    ).resolves.toBe(true);

    const [url, init] = fetchMock.mock.calls[0];
    // Shape asserted on the server side too, in
    // `server/tests/it/iroh_pairing.rs` — `?node=` is the contract.
    expect(url).toBe(
      `http://localhost:9883/forget-peer?node=${encodeURIComponent(NODE)}`,
    );
    expect(init.method).toBe('POST');
    // Signed over the full URL including the query string, or the server's
    // rebuild will not match.
    expect(init.headers['x-atomic-signed-url']).toBe(url);
  });

  it('reports failure rather than success when the server refuses', async () => {
    stubFetch({ ok: false, status: 401 });

    await expect(
      forgetServerPeer('http://localhost:9883', NODE, AGENT),
    ).resolves.toBe(false);
  });

  it('reports failure instead of throwing when the request cannot be made', async () => {
    globalThis.fetch = vi
      .fn()
      .mockRejectedValue(
        new Error('Failed to fetch'),
      ) as unknown as typeof fetch;

    await expect(
      forgetServerPeer('http://localhost:9883', NODE, AGENT),
    ).resolves.toBe(false);
  });

  it('does not call out at all when something required is missing', async () => {
    const fetchMock = stubFetch({ ok: true });

    await expect(forgetServerPeer('', NODE, AGENT)).resolves.toBe(false);
    await expect(
      forgetServerPeer('http://localhost:9883', '', AGENT),
    ).resolves.toBe(false);
    await expect(
      forgetServerPeer('http://localhost:9883', NODE, undefined as never),
    ).resolves.toBe(false);

    expect(fetchMock).not.toHaveBeenCalled();
  });
});
