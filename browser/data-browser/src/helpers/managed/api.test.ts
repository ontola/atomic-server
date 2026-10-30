import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// The desktop and Android apps are the case that matters: on
// `tauri://localhost` the API base comes entirely from what was remembered,
// which is exactly what a hostile node tries to overwrite.
const inTauri = { value: false };
vi.mock('../tauri', () => ({ isRunningInTauri: () => inTauri.value }));

const PORTAL = 'https://portal.example';
const OTHER = 'https://attacker.example';

// The default vitest environment here is `node`, so there is no localStorage —
// the same stand-in `deviceLink.test.ts` uses.
function installLocalStorage(): Map<string, string> {
  const store = new Map<string, string>();

  globalThis.localStorage = {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, value),
    removeItem: (key: string) => void store.delete(key),
    clear: () => store.clear(),
    key: (index: number) => [...store.keys()][index] ?? null,
    get length() {
      return store.size;
    },
  } as Storage;

  return store;
}

// The module keeps the remembered portal in memory as well as in storage, so
// every test gets a fresh copy of it.
async function freshApi() {
  vi.resetModules();

  return import('./api');
}

let storage: Map<string, string>;
let warn: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  storage = installLocalStorage();
  warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  inTauri.value = true;
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  inTauri.value = false;
});

// Every test here starts with `freshApi()`, which is `vi.resetModules()`
// followed by a dynamic import, so each one re-transforms and re-imports the
// module's whole graph rather than sharing one cached copy. That costs
// milliseconds on a quiet machine and far more than the 5s default when the
// test threads are oversubscribed, as they are on the shared runner. Same
// budget and same reason as `convertFileToDocument.test.ts`.
describe('safePortalUrl', () => {
  it('accepts absolute https URLs, trimming trailing slashes', async () => {
    const { safePortalUrl } = await freshApi();

    expect(safePortalUrl('https://portal.example')).toBe(PORTAL);
    expect(safePortalUrl('https://portal.example/')).toBe(PORTAL);
    expect(safePortalUrl('https://portal.example///')).toBe(PORTAL);
    expect(safePortalUrl('  https://portal.example/ ')).toBe(PORTAL);
    expect(safePortalUrl('https://portal.example/signin')).toBe(
      'https://portal.example/signin',
    );
  });

  it('accepts plain http only on localhost', async () => {
    const { safePortalUrl } = await freshApi();

    expect(safePortalUrl('http://localhost:49237')).toBe(
      'http://localhost:49237',
    );
    expect(safePortalUrl('http://127.0.0.1:49237/')).toBe(
      'http://127.0.0.1:49237',
    );
    expect(safePortalUrl('http://atomic.localhost:9883/')).toBe(
      'http://atomic.localhost:9883',
    );
    expect(safePortalUrl('http://evil-localhost')).toBeUndefined();
    expect(safePortalUrl('http://atomic.localhost.example')).toBeUndefined();
    expect(safePortalUrl('http://portal.example')).toBeUndefined();
    expect(safePortalUrl('http://localhost.example')).toBeUndefined();
  });

  it('refuses anything that is not a plain https address', async () => {
    const { safePortalUrl } = await freshApi();

    expect(safePortalUrl('javascript:alert(1)')).toBeUndefined();
    expect(safePortalUrl('data:text/html,hi')).toBeUndefined();
    expect(safePortalUrl('tauri://localhost')).toBeUndefined();
    expect(safePortalUrl('portal.example')).toBeUndefined();
    expect(safePortalUrl('/relative')).toBeUndefined();
    expect(safePortalUrl('https://user:pw@portal.example')).toBeUndefined();
    expect(safePortalUrl('')).toBeUndefined();
    expect(safePortalUrl('   ')).toBeUndefined();
    expect(safePortalUrl(null)).toBeUndefined();
    expect(safePortalUrl(undefined)).toBeUndefined();
  });
}, 60000);

describe('rememberManagedPortalUrl', () => {
  it('remembers a safe portal and serves it as the API base', async () => {
    const api = await freshApi();

    api.rememberManagedPortalUrl(`${PORTAL}/`);

    expect(api.getRememberedManagedPortalUrl()).toBe(PORTAL);
    expect(api.getManagedApiBase()).toBe(`${PORTAL}/api`);
    expect(storage.get('atomic-managed-portal-url')).toBe(PORTAL);
  });

  it('ignores a portal that is not https', async () => {
    const api = await freshApi();

    api.rememberManagedPortalUrl(PORTAL);
    api.rememberManagedPortalUrl('http://attacker.example');
    api.rememberManagedPortalUrl('javascript:alert(1)');

    expect(api.getRememberedManagedPortalUrl()).toBe(PORTAL);
    expect(warn).toHaveBeenCalledTimes(2);
  });

  it('ignores a falsy value rather than forgetting the portal', async () => {
    const api = await freshApi();

    api.rememberManagedPortalUrl(PORTAL);
    api.rememberManagedPortalUrl(null);
    api.rememberManagedPortalUrl('');

    expect(api.getRememberedManagedPortalUrl()).toBe(PORTAL);
  });

  it('re-checks a portal stored by an older build', async () => {
    storage.set('atomic-managed-portal-url', 'http://attacker.example');
    const api = await freshApi();

    expect(api.getRememberedManagedPortalUrl()).toBeNull();
    expect(api.getManagedApiBase()).toBe('/api');
  });
}, 60000);

describe('a linked device', () => {
  it('keeps the token bound when runtime configuration names another portal', async () => {
    const api = await freshApi();
    api.setManagedDeviceToken('sess', PORTAL);
    vi.stubGlobal('window', { __ATOMIC_MANAGED__: { portalUrl: OTHER } });
    expect(api.getManagedApiBase()).toBe(`${PORTAL}/api`);
  });

  /**
   * The bug this guards: a node's self-reported `portalUrl` used to become the
   * API base, and the bearer token went with it. Connecting the app to a
   * hostile server handed that server the control-plane session.
   */
  it('keeps sending its token to the portal it linked with, whatever a node says later', async () => {
    const api = await freshApi();

    api.setManagedDeviceToken('sess', PORTAL);
    expect(api.getLinkedPortalOrigin()).toBe(PORTAL);

    // What fetchManagedInfo does after connecting to a server that names
    // another portal.
    api.rememberManagedPortalUrl(OTHER);

    expect(api.getManagedApiBase()).toBe(`${PORTAL}/api`);
    expect(api.getRememberedManagedPortalUrl()).toBe(PORTAL);
    expect(storage.get('atomic-managed-portal-url')).not.toBe(OTHER);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining(OTHER));
  });

  it('sends managedFetch to the linked portal, with the token', async () => {
    const api = await freshApi();
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(Response.json({}));

    api.setManagedDeviceToken('sess', PORTAL);
    api.rememberManagedPortalUrl(OTHER);

    await api.managedFetch('/me', {});

    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe(`${PORTAL}/api/me`);
    expect((init!.headers as Headers).get('Authorization')).toBe('Bearer sess');
    expect(init!.credentials).toBe('omit');
  });

  it('still accepts the same origin from a node, trailing slash or not', async () => {
    const api = await freshApi();

    api.setManagedDeviceToken('sess', PORTAL);
    api.rememberManagedPortalUrl(`${PORTAL}/`);

    expect(warn).not.toHaveBeenCalled();
    expect(api.getManagedApiBase()).toBe(`${PORTAL}/api`);
  });

  it('is free to follow a new portal once unlinked', async () => {
    const api = await freshApi();

    api.setManagedDeviceToken('sess', PORTAL);
    api.setManagedDeviceToken(null);

    expect(api.getLinkedPortalOrigin()).toBeNull();
    expect(storage.has('atomic-managed-portal-origin-linked')).toBe(false);

    api.rememberManagedPortalUrl(OTHER);

    expect(api.getManagedApiBase()).toBe(`${OTHER}/api`);
  });

  it('does not record a link origin that is not https', async () => {
    const api = await freshApi();

    api.setManagedDeviceToken('sess', 'http://attacker.example');

    expect(api.getLinkedPortalOrigin()).toBeNull();
    expect(warn).toHaveBeenCalled();
  });

  /**
   * Installs that linked before the origin was recorded: the portal remembered
   * at that time is the one the token was issued by. It is adopted before any
   * node gets a chance to overwrite the memory.
   */
  it('adopts the portal an older build remembered, and keeps it against a later node', async () => {
    storage.set('atomic-managed-device-token', 'sess');
    storage.set('atomic-managed-portal-url', PORTAL);
    const api = await freshApi();

    api.rememberManagedPortalUrl(OTHER);

    expect(api.getLinkedPortalOrigin()).toBe(PORTAL);
    expect(api.getManagedApiBase()).toBe(`${PORTAL}/api`);
    expect(storage.get('atomic-managed-portal-origin-linked')).toBe(PORTAL);
  });

  it('has no link origin without a token', async () => {
    storage.set('atomic-managed-portal-origin-linked', PORTAL);
    const api = await freshApi();

    expect(api.getLinkedPortalOrigin()).toBeNull();
  });
}, 60000);

describe('browser control-plane routing', () => {
  beforeEach(() => {
    inTauri.value = false;
    vi.stubGlobal('window', { location: new URL('http://localhost:6747/app') });
    vi.stubEnv('VITE_MANAGED_API_BASE', '');
    vi.stubEnv('VITE_MANAGED_PORTAL_URL', '');
  });

  it.each(['localhost', '127.0.0.1'])(
    'does not infer a SaaS backend from %s',
    async hostname => {
      vi.stubGlobal('window', { location: { hostname } });
      const api = await freshApi();
      expect(api.hasManagedApi()).toBe(false);
      expect(api.getManagedApiBase()).toBe('/api');
    },
  );

  it('uses an explicitly configured local SaaS backend', async () => {
    vi.stubEnv('VITE_MANAGED_API_BASE', 'http://localhost:3030/api/');
    const api = await freshApi();
    expect(api.hasManagedApi()).toBe(true);
    expect(api.getManagedApiBase()).toBe('http://localhost:3030/api');
  });

  it('keeps cookie credentials for an unlinked hosted browser session', async () => {
    vi.stubGlobal('window', {
      location: new URL('https://app.atomic.place/app/sync'),
    });
    vi.stubEnv('VITE_MANAGED_API_BASE', 'https://atomic.place/api');
    const api = await freshApi();
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(Response.json({}));

    await api.managedFetch('/me');

    expect(fetchMock.mock.calls[0][1]?.credentials).toBe('include');
  });

  it('uses a discovered portal in the browser', async () => {
    const api = await freshApi();
    api.rememberManagedPortalUrl(PORTAL);
    expect(api.hasManagedApi()).toBe(true);
    expect(api.getManagedApiBase()).toBe(`${PORTAL}/api`);
  });

  it('uses the build portal in the browser', async () => {
    vi.stubEnv('VITE_MANAGED_PORTAL_URL', PORTAL);
    const api = await freshApi();
    expect(api.hasManagedApi()).toBe(true);
    expect(api.getManagedApiBase()).toBe(`${PORTAL}/api`);
  });
}, 60000);

describe('managed request credentials', () => {
  beforeEach(() => {
    inTauri.value = false;
    vi.stubEnv('VITE_MANAGED_API_BASE', '');
    vi.stubEnv('VITE_MANAGED_PORTAL_URL', '');
  });

  function at(href: string) {
    vi.stubGlobal('window', { location: new URL(href) });
  }

  it.each([
    ['http://localhost:11870/app/sync', 'https://atomic.place/api'],
    ['https://notatomic.place/app', 'https://atomic.place/api'],
    [
      'https://app.atomic.place.attacker.example/app',
      'https://atomic.place/api',
    ],
    ['http://app.atomic.place/app', 'https://atomic.place/api'],
    ['https://app.atomic.place/app', 'http://atomic.place/api'],
  ])('omits cookies from unlinked %s to %s', async (here, apiBase) => {
    at(here);
    vi.stubEnv('VITE_MANAGED_API_BASE', apiBase);
    const api = await freshApi();
    const fetch = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(Response.json({}));

    await api.managedFetch('/me', { credentials: 'include' });

    expect(fetch.mock.calls[0][1]?.credentials).toBe('omit');
    expect(
      (fetch.mock.calls[0][1]!.headers as Headers).has('Authorization'),
    ).toBe(false);
  });

  it.each([
    ['https://app.atomic.place/app/sync', 'https://atomic.place/api'],
    ['http://localhost:11870/app/sync', 'http://localhost:3030/api'],
    ['http://127.0.0.1:11870/app/sync', 'http://127.0.0.1:3030/api'],
    ['https://app.atomic.place/app/sync', '/api'],
  ])('keeps hosted cookies from %s to %s', async (here, apiBase) => {
    at(here);
    vi.stubEnv('VITE_MANAGED_API_BASE', apiBase);
    const api = await freshApi();
    const fetch = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(Response.json({}));

    await api.managedFetch('/me');

    expect(String(fetch.mock.calls[0][0])).toBe(`${apiBase}/me`);
    expect(fetch.mock.calls[0][1]?.credentials).toBe('include');
  });

  it('omits cookies in a native WebView even at a matching HTTP development address', async () => {
    at('http://localhost:11870/app/sync');
    inTauri.value = true;
    vi.stubEnv('VITE_MANAGED_API_BASE', 'http://localhost:3030/api');
    const api = await freshApi();
    const fetch = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(Response.json({}));

    await api.managedFetch('/me', { credentials: 'include' });

    expect(fetch.mock.calls[0][1]?.credentials).toBe('omit');
  });

  it('omits cookies for an explicit bearer on a hosted page without a stored device token', async () => {
    at('https://app.atomic.place/app/sync');
    vi.stubEnv('VITE_MANAGED_API_BASE', 'https://atomic.place/api');
    const api = await freshApi();
    const fetch = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(Response.json({}));

    await api.managedFetch('/me', {
      credentials: 'include',
      headers: { Authorization: 'Bearer caller-session' },
    });

    expect(fetch.mock.calls[0][1]?.credentials).toBe('omit');
    expect(
      (fetch.mock.calls[0][1]!.headers as Headers).get('Authorization'),
    ).toBe('Bearer caller-session');
    expect(api.getManagedDeviceToken()).toBeNull();
  });

  it('uses only the bearer and pinned issuer even when a hosted page could hold cookies', async () => {
    at('https://app.portal.example/app/sync');
    const api = await freshApi();
    api.setManagedDeviceToken('linked-session', PORTAL);
    vi.stubGlobal('window', {
      location: new URL('https://app.portal.example/app/sync'),
      __ATOMIC_MANAGED__: { portalUrl: OTHER },
    });
    const fetch = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(Response.json({}));

    await api.managedFetch('/me', { credentials: 'include' });

    expect(String(fetch.mock.calls[0][0])).toBe(`${PORTAL}/api/me`);
    expect(fetch.mock.calls[0][1]?.credentials).toBe('omit');
    expect(
      (fetch.mock.calls[0][1]!.headers as Headers).get('Authorization'),
    ).toBe('Bearer linked-session');
  });
});

it('refreshes shared metadata when returning from the portal or unlinking', async () => {
  const events = new EventTarget();
  vi.stubGlobal('window', events);
  const api = await freshApi();
  api.rememberManagedPortalUrl(PORTAL);
  const fetch = vi
    .spyOn(globalThis, 'fetch')
    .mockImplementation(async () => Response.json({ email: 'a@example.com' }));
  await api.managedFetch('/me');
  await api.managedFetch('/me');
  expect(fetch).toHaveBeenCalledTimes(1);
  events.dispatchEvent(new Event('focus'));
  await api.managedFetch('/me');
  expect(fetch).toHaveBeenCalledTimes(2);
  api.setManagedDeviceToken(null);
  await api.managedFetch('/me');
  expect(fetch).toHaveBeenCalledTimes(3);
});
