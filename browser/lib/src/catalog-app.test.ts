import { describe, expect, it } from 'vitest';
import {
  catalogAppProperties as p,
  catalogAppState,
  compareVersions,
  fetchCatalogAppModule,
  parseCatalogApp,
  subresourceIntegrity,
} from './catalog-app.js';

const CATALOG =
  'https://ontola.github.io/atomic-plugins/integrations/catalog.json';
const SOURCE =
  'export async function view({ root }) { root.textContent = "hi"; }';

const entry = (overrides: Record<string, unknown> = {}) => ({
  [p.shortname]: 'pets',
  [p.name]: 'Pets',
  [p.version]: '0.1.0',
  [p.module]: 'https://cdn.jsdelivr.net/npm/atomic-app-pets@0.1.0/ui.js',
  [p.integrity]: 'sha384-AAAA',
  ...overrides,
});

const serve =
  (body: string, status = 200): typeof fetch =>
  async () =>
    new Response(body, { status });

describe('parseCatalogApp', () => {
  it('reads an app entry', () => {
    expect(
      parseCatalogApp(
        entry({ [p.rowName]: 'Pet', [p.rowNamePlural]: 'Pets' }),
        CATALOG,
      ),
    ).toMatchObject({
      id: 'pets',
      version: '0.1.0',
      module: 'https://cdn.jsdelivr.net/npm/atomic-app-pets@0.1.0/ui.js',
      rowName: { singular: 'Pet', plural: 'Pets' },
    });
  });

  it('skips entries that are not installable apps', () => {
    expect(parseCatalogApp(entry({ [p.module]: undefined }), CATALOG)).toBe(
      undefined,
    );
    expect(parseCatalogApp(entry({ [p.version]: undefined }), CATALOG)).toBe(
      undefined,
    );
    expect(parseCatalogApp(entry({ [p.integrity]: 'md5-x' }), CATALOG)).toBe(
      undefined,
    );
    expect(
      parseCatalogApp(
        entry({ [p.module]: 'http://example.com/ui.js' }),
        CATALOG,
      ),
    ).toBe(undefined);
    expect(parseCatalogApp('nope', CATALOG)).toBe(undefined);
  });

  it('resolves a relative module against the catalog, and allows loopback HTTP', () => {
    expect(
      parseCatalogApp(entry({ [p.module]: 'pets/app/ui.js' }), CATALOG)?.module,
    ).toBe(
      'https://ontola.github.io/atomic-plugins/integrations/pets/app/ui.js',
    );
    expect(
      parseCatalogApp(
        entry({
          [p.module]: 'http://localhost:9881/integrations/pets/app/ui.js',
        }),
        CATALOG,
      )?.module,
    ).toBe('http://localhost:9881/integrations/pets/app/ui.js');
  });
});

describe('fetchCatalogAppModule', () => {
  it('returns bytes that match the pinned integrity', async () => {
    const integrity = await subresourceIntegrity(SOURCE);
    expect(integrity).toMatch(/^sha384-/);
    const app = {
      ...parseCatalogApp(entry({ [p.integrity]: integrity }), CATALOG)!,
    };
    await expect(fetchCatalogAppModule(app, serve(SOURCE))).resolves.toBe(
      SOURCE,
    );
  });

  it('refuses bytes that do not match, and failed downloads', async () => {
    const app = {
      ...parseCatalogApp(
        entry({ [p.integrity]: await subresourceIntegrity(SOURCE) }),
        CATALOG,
      )!,
    };
    await expect(
      fetchCatalogAppModule(app, serve(`${SOURCE}\n// tampered`)),
    ).rejects.toThrow(/does not match the catalog/);
    await expect(fetchCatalogAppModule(app, serve('', 404))).rejects.toThrow(
      /could not be downloaded \(404\)/,
    );
  });
});

describe('versions', () => {
  it('compares dotted numeric versions', () => {
    expect(compareVersions('0.10.0', '0.9.1')).toBe(1);
    expect(compareVersions('0.1.0', '0.1.0')).toBe(0);
    expect(compareVersions('1.0.0-beta.1', '1.0.0')).toBe(-1);
    expect(compareVersions('0.1', '0.1.0')).toBe(0);
  });

  it('offers install, update or nothing — never a downgrade', () => {
    expect(catalogAppState({ version: '0.2.0' }, undefined)).toBe('install');
    expect(catalogAppState({ version: '0.2.0' }, { version: '0.1.0' })).toBe(
      'update',
    );
    expect(catalogAppState({ version: '0.2.0' }, { version: '0.2.0' })).toBe(
      'current',
    );
    expect(catalogAppState({ version: '0.2.0' }, { version: '0.3.0' })).toBe(
      'ahead',
    );
    expect(catalogAppState({ version: '0.2.0' }, {})).toBe('update');
  });
});
