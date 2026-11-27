import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const runtime = vi.hoisted(() => ({ native: false }));
vi.mock('../tauri', () => ({ isRunningInTauri: () => runtime.native }));

let fetcher: ReturnType<typeof vi.fn>;
let location: { href: string };
const provider = 'https://account.example/api';

beforeEach(() => {
  vi.resetModules();
  runtime.native = false;
  const storage = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
    removeItem: (key: string) => storage.delete(key),
  });
  location = { href: 'https://self-hosted.example/app' };
  vi.stubGlobal('window', {
    location,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  });
  vi.stubGlobal('document', {
    visibilityState: 'visible',
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  });
  vi.stubEnv('VITE_MANAGED_API_BASE', provider);
  fetcher = vi.fn(async () => Response.json({ email: 'acct_test' }));
  vi.stubGlobal('fetch', fetcher);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

it.each([false, true])(
  'does not probe an unlinked offsite client (native=%s)',
  async native => {
    runtime.native = native;
    const session = await import('./session');
    expect(await session.getManagedAccount()).toBeNull();
    expect(await session.getManagedAccount({ fresh: true })).toBeNull();
    expect(await session.hasManagedSession()).toBe(false);
    expect(fetcher).not.toHaveBeenCalled();
  },
);

it.each(['https://app.account.example/app', 'https://account.example/app'])(
  'still checks a cookie-eligible hosted account at %s',
  async href => {
    location.href = href;
    const session = await import('./session');
    expect(await session.getManagedAccount()).toEqual({ email: 'acct_test' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0][1]).toMatchObject({ credentials: 'include' });
  },
);

it('still checks a linked native account with its issuing provider token', async () => {
  runtime.native = true;
  const api = await import('./api');
  api.setManagedDeviceToken('linked-test-token', 'https://account.example');
  const session = await import('./session');
  expect(await session.getManagedAccount()).toEqual({ email: 'acct_test' });
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(fetcher.mock.calls[0][0]).toBe(`${provider}/me`);
  expect(fetcher.mock.calls[0][1]).toMatchObject({ credentials: 'omit' });
  expect(
    new Headers(fetcher.mock.calls[0][1].headers).get('Authorization'),
  ).toBe('Bearer linked-test-token');
});

it('does not reuse a settled account after the offsite token is removed', async () => {
  const api = await import('./api');
  api.setManagedDeviceToken('linked-test-token', 'https://account.example');
  const session = await import('./session');
  expect(await session.getManagedAccount()).toEqual({ email: 'acct_test' });
  api.setManagedDeviceToken(null);
  expect(await session.getManagedAccount()).toBeNull();
  expect(fetcher).toHaveBeenCalledTimes(1);
});

it('does not reuse a cookie account once the client is no longer cookie eligible', async () => {
  location.href = 'https://app.account.example/app';
  const session = await import('./session');
  expect(await session.getManagedAccount()).toEqual({ email: 'acct_test' });
  location.href = 'https://self-hosted.example/app';
  expect(await session.getManagedAccount()).toBeNull();
  expect(fetcher).toHaveBeenCalledTimes(1);
});

it('retains same-host local development cookie authentication across ports', async () => {
  location.href = 'http://localhost:9883/app';
  vi.stubEnv('VITE_MANAGED_API_BASE', 'http://localhost:3031/api');
  const session = await import('./session');
  expect(await session.getManagedAccount()).toEqual({ email: 'acct_test' });
  expect(fetcher.mock.calls[0][0]).toBe('http://localhost:3031/api/me');
  expect(fetcher.mock.calls[0][1]).toMatchObject({ credentials: 'include' });
});
