import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The catalog URL and the integration proxy are read from localStorage at
 * runtime; the `VITE_*` values are only the default. That is what lets one
 * unmodified e2e binary serve a lane whose catalog and proxy sit on arbitrary
 * ports — playwright seeds both keys through `storageState` (see
 * browser/e2e/playwright.config.ts) instead of anything being rebuilt.
 *
 * These tests run in plain node, like the rest of this folder: a map stands in
 * for storage and an event target for `window`, both installed before the
 * first import because the modules read storage and env at module scope. Each
 * case stubs the env and re-imports rather than sharing one instance.
 */
class MemoryStorage {
  private data = new Map<string, string>();

  getItem(key: string): string | null {
    return this.data.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.data.set(key, value);
  }

  removeItem(key: string): void {
    this.data.delete(key);
  }

  clear(): void {
    this.data.clear();
  }
}

Object.assign(globalThis, {
  localStorage: new MemoryStorage(),
  window: new EventTarget(),
});

const CATALOG_KEY = 'plugin-catalog-url';
const PROXY_KEY = 'integration-proxy-url';

const PUBLIC_CATALOG =
  'https://ontola.github.io/atomic-plugins/integrations/catalog.json';
const PUBLIC_PROXY = 'https://localthought.io';

const catalog = (env?: string) => {
  vi.resetModules();

  if (env === undefined) {
    vi.stubEnv('VITE_PLUGIN_CATALOG_URL', '');
  } else {
    vi.stubEnv('VITE_PLUGIN_CATALOG_URL', env);
  }

  return import('./pluginCatalogUrl');
};

const proxy = (env?: string) => {
  vi.resetModules();
  vi.stubEnv('VITE_INTEGRATION_PROXY_URL', env ?? '');

  return import('./integrationProxy');
};

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('plugin catalog URL', () => {
  it('prefers a seeded value over the build-time default', async () => {
    localStorage.setItem(
      CATALOG_KEY,
      'http://127.0.0.1:9880/integrations/catalog.json',
    );
    const { getPluginCatalogUrl, defaultPluginCatalogUrl } = await catalog(
      'http://localhost:9999/integrations/catalog.json',
    );

    expect(defaultPluginCatalogUrl).toBe(
      'http://localhost:9999/integrations/catalog.json',
    );
    expect(getPluginCatalogUrl()).toBe(
      'http://127.0.0.1:9880/integrations/catalog.json',
    );
  });

  it('falls back to the default when the seeded value is invalid', async () => {
    localStorage.setItem(CATALOG_KEY, 'http://evil.example.com/catalog.json');
    const { getPluginCatalogUrl, defaultPluginCatalogUrl } = await catalog();

    expect(getPluginCatalogUrl()).toBe(defaultPluginCatalogUrl);
    expect(defaultPluginCatalogUrl).toBe(PUBLIC_CATALOG);
  });

  it('survives a seeded value that is not a URL at all', async () => {
    localStorage.setItem(CATALOG_KEY, 'not a url');
    const { getPluginCatalogUrl } = await catalog();

    expect(getPluginCatalogUrl()).toBe(PUBLIC_CATALOG);
  });

  it('ignores a build-time default that would never validate', async () => {
    const { defaultPluginCatalogUrl } = await catalog(
      'http://elsewhere.example/catalog.json',
    );

    expect(defaultPluginCatalogUrl).toBe(PUBLIC_CATALOG);
  });

  // The dagger pipeline serves the browser from `*.localhost` names, which
  // RFC 6761 gives to loopback; the bare-name check rejected them.
  it('accepts a loopback subdomain over http', async () => {
    localStorage.setItem(
      CATALOG_KEY,
      'http://atomic.localhost:9883/integrations/catalog.json',
    );
    const { getPluginCatalogUrl } = await catalog();

    expect(getPluginCatalogUrl()).toBe(
      'http://atomic.localhost:9883/integrations/catalog.json',
    );
  });

  it('round-trips through the settings-screen setter', async () => {
    const {
      setPluginCatalogUrl,
      getPluginCatalogUrl,
      defaultPluginCatalogUrl,
    } = await catalog();

    setPluginCatalogUrl('https://example.com/catalog.json');
    expect(getPluginCatalogUrl()).toBe('https://example.com/catalog.json');

    setPluginCatalogUrl('');
    expect(getPluginCatalogUrl()).toBe(defaultPluginCatalogUrl);

    expect(() =>
      setPluginCatalogUrl('http://evil.example.com/c.json'),
    ).toThrow();
  });
});

describe('integration proxy', () => {
  it('prefers a seeded value over the build-time default', async () => {
    localStorage.setItem(PROXY_KEY, 'http://127.0.0.1:19042');
    const { getIntegrationProxy, defaultIntegrationProxy } = await proxy(
      'http://atomic.localhost:19090',
    );

    expect(defaultIntegrationProxy).toBe('http://atomic.localhost:19090');
    expect(getIntegrationProxy()).toBe('http://127.0.0.1:19042');
  });

  it('falls back to the default instead of throwing out of a render', async () => {
    localStorage.setItem(PROXY_KEY, 'http://127.0.0.1:19042/with/a/path');
    const { getIntegrationProxy, defaultIntegrationProxy } = await proxy();

    expect(getIntegrationProxy()).toBe(defaultIntegrationProxy);
    expect(defaultIntegrationProxy).toBe(PUBLIC_PROXY);
  });

  it('ignores a build-time default that is not a bare origin', async () => {
    const { defaultIntegrationProxy } = await proxy(
      'http://127.0.0.1:19090/proxy',
    );

    expect(defaultIntegrationProxy).toBe(PUBLIC_PROXY);
  });

  it('round-trips through the settings-screen setter', async () => {
    const {
      setIntegrationProxy,
      getIntegrationProxy,
      defaultIntegrationProxy,
    } = await proxy();

    setIntegrationProxy('http://localhost:19090/');
    expect(getIntegrationProxy()).toBe('http://localhost:19090');

    setIntegrationProxy('');
    expect(getIntegrationProxy()).toBe(defaultIntegrationProxy);

    expect(() => setIntegrationProxy('http://evil.example.com')).toThrow();
  });
});
