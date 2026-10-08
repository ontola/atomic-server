// @wc-ignore-file
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { lensGet } from './lens';
import {
  clearLensCatalogCache,
  fetchLensCatalog,
  loadLensCatalog,
} from './lensCatalog';
import { PINNED_LENS_CATALOG_URL } from './lensCatalogUrl';
import { loadCatalogLenses } from './loadPieces';
import { offersForTable, type PieceInfo } from './offers';
import { PIECES_FLAG_KEY } from './piecesFlag';

/**
 * Release 1 of the shared lens catalog, copied byte for byte from
 * ontola/atomic-plugins `ontology/lenses/` on main (the files Pages serves).
 */
const BASE = 'https://ontola.github.io/atomic-plugins/ontology';
const NAMES = [
  'v1',
  'clockify-time-entry-v1',
  'todoist-task-issue-v1',
  'raindrop-bookmark-v1',
  'solid-bookmark-v1',
];
const fixture = (name: string): string =>
  readFileSync(
    fileURLToPath(
      new URL(`./fixtures/lenses-v1/${name}.json`, import.meta.url),
    ),
    'utf8',
  );

const ISSUE = `${BASE}/classes/issue-v1`;
const TODOIST_TASK = 'record:APIs/todoist.com/1#task';
const TODOIST_LENS = `${BASE}/lenses/todoist-task-issue-v1`;

const todoist: PieceInfo = {
  subject: 'https://drive.example/apps/todoist',
  name: 'Todoist',
  kind: 'integration',
  renders: [TODOIST_TASK],
};

/** A fetch serving `files` (URL to text), 404 for anything else. */
function serve(files: Record<string, string>) {
  return vi.fn(
    async (url: string) =>
      new Response(files[url] ?? 'not found', {
        status: url in files ? 200 : 404,
        headers: { 'Content-Type': 'application/octet-stream' },
      }),
  );
}

const release1 = (): Record<string, string> =>
  Object.fromEntries(
    NAMES.map(name => [`${BASE}/lenses/${name}`, fixture(name)]),
  );

/** Release 1 with one lens's mapping moved to a version this host lacks. */
function withMappingVersion(version: number): Record<string, string> {
  const files = release1();
  const clockify = JSON.parse(files[`${BASE}/lenses/clockify-time-entry-v1`]);
  clockify.mapping.version = version;
  files[`${BASE}/lenses/clockify-time-entry-v1`] = JSON.stringify(clockify);

  return files;
}

let storage: Map<string, string>;

beforeEach(() => {
  storage = new Map([[PIECES_FLAG_KEY, 'true']]);
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
    removeItem: (key: string) => storage.delete(key),
  });
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  clearLensCatalogCache();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('the pinned lens catalog', () => {
  it('pins release 1', () => {
    expect(PINNED_LENS_CATALOG_URL).toBe(`${BASE}/lenses/v1`);
  });

  it('reads release 1: four lenses, mapping version 2', async () => {
    const { lenses, skipped } = await fetchLensCatalog(
      `${BASE}/lenses/v1`,
      serve(release1()),
    );

    expect(skipped).toEqual([]);
    expect(lenses.map(l => l.subject)).toEqual(
      NAMES.slice(1).map(name => `${BASE}/lenses/${name}`),
    );
    expect(lenses.every(l => l.mappingVersion === 2)).toBe(true);
    expect(lenses.find(l => l.subject === TODOIST_LENS)).toMatchObject({
      name: 'Todoist task ↔ Issue',
      source: TODOIST_TASK,
      target: ISSUE,
    });
  });

  it('runs each catalog lens on its own examples', async () => {
    const { lenses } = await fetchLensCatalog(
      `${BASE}/lenses/v1`,
      serve(release1()),
    );

    for (const lens of lenses) {
      const file = JSON.parse(fixture(lens.subject.split('/').pop()!));

      for (const example of file.examples)
        expect(lensGet(lens.mapping, example.source)).toEqual(example.target);
    }
  });

  it('offers Todoist on an issue-v1 table through the catalog lens, trusted', async () => {
    vi.stubGlobal('fetch', serve(release1()));
    const lenses = await loadCatalogLenses();
    const offers = offersForTable([todoist], lenses, ISSUE);

    expect(lenses.every(l => l.trusted && l.origin === 'catalog')).toBe(true);
    expect(offers).toHaveLength(1);
    expect(offers[0].piece.name).toBe('Todoist');
    expect(offers[0].path).toEqual([
      { lens: TODOIST_LENS, direction: 'backward' },
    ]);
    expect(offers[0].pendingReview).toEqual([]);
  });

  it('skips a lens with an unknown mappingVersion, without failing the offers', async () => {
    vi.stubGlobal('fetch', serve(withMappingVersion(3)));
    const lenses = await loadCatalogLenses();

    expect(lenses.map(l => l.subject)).not.toContain(
      `${BASE}/lenses/clockify-time-entry-v1`,
    );
    expect(lenses).toHaveLength(3);
    expect(offersForTable([todoist], lenses, ISSUE)).toHaveLength(1);
    expect(console.warn).toHaveBeenCalledWith(
      expect.stringMatching(/clockify-time-entry-v1 \(mapping version 3\)/),
    );
  });

  it('refuses a release with an unknown lensFormat: no lenses, a warning', async () => {
    const files = release1();
    files[`${BASE}/lenses/v1`] = JSON.stringify({
      ...JSON.parse(files[`${BASE}/lenses/v1`]),
      lensFormat: 2,
    });

    expect(await loadLensCatalog(`${BASE}/lenses/v1`, serve(files))).toEqual(
      [],
    );
    expect(console.warn).toHaveBeenCalled();
  });

  it('skips a lens file with an unknown lensFormat, or not served at its subject', async () => {
    const files = release1();
    const solid = `${BASE}/lenses/solid-bookmark-v1`;
    const raindrop = `${BASE}/lenses/raindrop-bookmark-v1`;
    files[solid] = JSON.stringify({
      ...JSON.parse(files[solid]),
      lensFormat: 9,
    });
    files[raindrop] = JSON.stringify({
      ...JSON.parse(files[raindrop]),
      '@id': 'https://elsewhere.example/lens',
    });
    const { lenses, skipped } = await fetchLensCatalog(
      `${BASE}/lenses/v1`,
      serve(files),
    );

    expect(lenses).toHaveLength(2);
    expect(skipped.map(s => s.subject).sort()).toEqual([raindrop, solid]);
  });

  it('caches per release URL', async () => {
    const fetch = serve(release1());
    const first = await loadLensCatalog(`${BASE}/lenses/v1`, fetch);
    const calls = fetch.mock.calls.length;
    const second = await loadLensCatalog(`${BASE}/lenses/v1`, fetch);

    expect(second).toBe(first);
    expect(fetch.mock.calls.length).toBe(calls);
    expect(calls).toBe(NAMES.length);
  });

  it('gives [] with a warning when the release cannot be fetched, and tries again next time', async () => {
    const down = vi.fn(async () => {
      throw new TypeError('Failed to fetch');
    });

    expect(await loadLensCatalog(`${BASE}/lenses/v1`, down)).toEqual([]);
    expect(console.warn).toHaveBeenCalled();
    expect(
      await loadLensCatalog(`${BASE}/lenses/v1`, serve(release1())),
    ).toHaveLength(4);
  });

  it('does not cache a load that missed a lens file', async () => {
    const files = release1();
    delete files[`${BASE}/lenses/solid-bookmark-v1`];

    expect(
      await loadLensCatalog(`${BASE}/lenses/v1`, serve(files)),
    ).toHaveLength(3);
    expect(
      await loadLensCatalog(`${BASE}/lenses/v1`, serve(release1())),
    ).toHaveLength(4);
  });

  it('loads nothing and fetches nothing while the split-pieces flag is off', async () => {
    storage.delete(PIECES_FLAG_KEY);
    const fetch = serve(release1());
    vi.stubGlobal('fetch', fetch);

    expect(await loadLensCatalog()).toEqual([]);
    expect(await loadCatalogLenses()).toEqual([]);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('loads the release a stored lens-catalog-url names', async () => {
    const lane = 'http://localhost:8091/ontology/lenses/v1';
    storage.set('lens-catalog-url', lane);
    const fetch = serve({});
    vi.stubGlobal('fetch', fetch);
    await loadLensCatalog();

    expect(fetch).toHaveBeenCalledWith(lane, expect.anything());
  });
});
