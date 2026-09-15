import { describe, it, expect, vi, afterEach } from 'vitest';
import { hostingRequest } from './hostingClient';
import { signRequest, type Store } from '@tomic/lib';
vi.mock('@tomic/lib', () => ({
  signRequest: vi.fn(async () => ({ 'x-atomic-signature': 'proof' })),
  errorMessageFromResponse: (body: string) => body,
}));
afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});
const store = {
  getServerUrl: () => 'https://atomic.example',
  getDrive: () => 'did:ad:drive',
  getAgent: () => ({ subject: 'owner', privateKey: 'secret' }),
} as unknown as Store;
describe('hosting control requests', () => {
  it('signs the API and excludes the key from uploads', async () => {
    const fetch = vi.fn(async (..._args: unknown[]) => ({
      ok: true,
      json: async () => ({ state: null }),
    }));
    vi.stubGlobal('fetch', fetch);
    await hostingRequest(store, 'did:ad:website', '/deployments', {
      version: 1,
      files: { 'index.html': 'Bread' },
    });
    const [url, options] = fetch.mock.calls[0] as [URL, RequestInit];
    expect(url.origin).toBe('https://atomic.example');
    expect(url.searchParams.get('drive')).toBe('did:ad:drive');
    expect(signRequest).toHaveBeenCalledWith(
      url.toString(),
      store.getAgent(),
      {},
    );
    expect(options.credentials).toBe('omit');
    expect(options.redirect).toBe('error');
    expect(options.body).not.toContain('secret');
  });
  it('surfaces conflicts without retrying', async () => {
    const fetch = vi.fn(async () => ({
      ok: false,
      status: 409,
      text: async () => 'Publication changed',
    }));
    vi.stubGlobal('fetch', fetch);
    await expect(
      hostingRequest(store, 'project', '/activate', {
        expectedRevision: 1,
        deployment: 'old',
      }),
    ).rejects.toThrow('Publication changed');
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
