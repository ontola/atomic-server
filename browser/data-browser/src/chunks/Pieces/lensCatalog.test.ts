// @wc-ignore-file
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LENS_MAPPING_VERSIONS, lensGet, lensPut } from './lens';
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
 * Releases 1 and 2 of the shared lens catalog, copied byte for byte from
 * ontola/atomic-plugins `ontology/lenses/` on main (the files Pages serves).
 */
const BASE = 'https://ontola.github.io/atomic-plugins/ontology';
const RELEASES = {
  v1: [
    'clockify-time-entry-v1',
    'todoist-task-issue-v1',
    'raindrop-bookmark-v1',
    'solid-bookmark-v1',
  ],
  v2: [
    'clockify-time-entry-v2',
    'todoist-task-issue-v2',
    'raindrop-bookmark-v2',
    'solid-bookmark-v1',
  ],
} as const;
type Release = keyof typeof RELEASES;

const fixture = (release: Release, name: string): string =>
  readFileSync(
    fileURLToPath(
      new URL(`./fixtures/lenses-${release}/${name}.json`, import.meta.url),
    ),
    'utf8',
  );

const lensUrl = (name: string) => `${BASE}/lenses/${name}`;
const releaseUrl = (release: Release) => lensUrl(release);

const ISSUE = `${BASE}/classes/issue-v1`;
const TODOIST_TASK = 'record:APIs/todoist.com/1#task';
const TODOIST_LENS = lensUrl('todoist-task-issue-v2');
const CLOCKIFY_LENS = lensUrl('clockify-time-entry-v2');

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

const files = (release: Release): Record<string, string> =>
  Object.fromEntries(
    [release, ...RELEASES[release]].map(name => [
      lensUrl(name),
      fixture(release, name),
    ]),
  );

/** Release 2 with one lens's mapping moved to `version`. */
function withMappingVersion(version: number): Record<string, string> {
  const out = files('v2');
  const clockify = JSON.parse(out[CLOCKIFY_LENS]);
  clockify.mapping.version = version;
  out[CLOCKIFY_LENS] = JSON.stringify(clockify);

  return out;
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
  it('pins release 2, and runs its mapping versions 2 and 3', () => {
    expect(PINNED_LENS_CATALOG_URL).toBe(releaseUrl('v2'));
    expect(LENS_MAPPING_VERSIONS).toEqual([1, 2, 3]);
  });

  it('reads release 2: three version-3 lenses and Solid at version 2', async () => {
    const { lenses, skipped } = await fetchLensCatalog(
      releaseUrl('v2'),
      serve(files('v2')),
    );

    expect(skipped).toEqual([]);
    expect(lenses.map(l => [l.subject, l.mappingVersion])).toEqual([
      [CLOCKIFY_LENS, 3],
      [TODOIST_LENS, 3],
      [lensUrl('raindrop-bookmark-v2'), 3],
      [lensUrl('solid-bookmark-v1'), 2],
    ]);
    expect(lenses.find(l => l.subject === TODOIST_LENS)).toMatchObject({
      name: 'Todoist task ↔ Issue',
      source: TODOIST_TASK,
      target: ISSUE,
    });
  });

  it('still reads release 1 when it is pinned through the override', async () => {
    const { lenses, skipped } = await fetchLensCatalog(
      releaseUrl('v1'),
      serve(files('v1')),
    );

    expect(skipped).toEqual([]);
    expect(lenses.every(l => l.mappingVersion === 2)).toBe(true);
  });

  it.each(['v1', 'v2'] as const)(
    'runs each lens of release %s on its own examples, refusals and guards included',
    async release => {
      const { lenses } = await fetchLensCatalog(
        releaseUrl(release),
        serve(files(release)),
      );

      for (const lens of lenses) {
        const file = JSON.parse(
          fixture(release, lens.subject.split('/').pop()!),
        );

        for (const example of file.examples) {
          if (example.error) {
            expect(() => lensGet(lens.mapping, example.source)).toThrow(
              expect.objectContaining({ code: example.error }),
            );
            continue;
          }

          expect(lensGet(lens.mapping, example.source)).toEqual(example.target);

          for (const edit of example.edits ?? []) {
            const backward = edit.direction === 'backward';
            const put = () =>
              backward
                ? lensPut(lens.mapping, edit.source, example.target, 'backward')
                : lensPut(lens.mapping, edit.target, example.source);

            if (edit.error)
              expect(put).toThrow(
                expect.objectContaining({ code: edit.error }),
              );
            else expect(put()).toEqual(backward ? edit.target : edit.source);
          }
        }
      }
    },
  );

  it('offers Todoist on an issue-v1 table through the catalog lens, trusted', async () => {
    vi.stubGlobal('fetch', serve(files('v2')));
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
    vi.stubGlobal('fetch', serve(withMappingVersion(4)));
    const lenses = await loadCatalogLenses();

    expect(lenses.map(l => l.subject)).not.toContain(CLOCKIFY_LENS);
    expect(lenses).toHaveLength(3);
    expect(offersForTable([todoist], lenses, ISSUE)).toHaveLength(1);
    expect(console.warn).toHaveBeenCalledWith(
      expect.stringMatching(/clockify-time-entry-v2 \(mapping version 4\)/),
    );
  });

  it('a host that runs only versions 1 and 2 skips release 2’s version-3 lenses and keeps Solid', async () => {
    const { lenses, skipped } = await fetchLensCatalog(
      releaseUrl('v2'),
      serve(files('v2')),
      [1, 2],
    );

    expect(lenses.map(l => l.subject)).toEqual([lensUrl('solid-bookmark-v1')]);
    expect(skipped.map(s => [s.subject, s.reason])).toEqual([
      [CLOCKIFY_LENS, 'mapping version 3'],
      [TODOIST_LENS, 'mapping version 3'],
      [lensUrl('raindrop-bookmark-v2'), 'mapping version 3'],
    ]);
    expect(
      offersForTable(
        [todoist],
        lenses.map(l => ({ ...l, trusted: true })),
        ISSUE,
      ),
    ).toEqual([]);
  });

  it('refuses a release with an unknown lensFormat: no lenses, a warning', async () => {
    const out = files('v2');
    out[releaseUrl('v2')] = JSON.stringify({
      ...JSON.parse(out[releaseUrl('v2')]),
      lensFormat: 2,
    });

    expect(await loadLensCatalog(releaseUrl('v2'), serve(out))).toEqual([]);
    expect(console.warn).toHaveBeenCalled();
  });

  it('skips a lens file with an unknown lensFormat, or not served at its subject', async () => {
    const out = files('v2');
    const solid = lensUrl('solid-bookmark-v1');
    const raindrop = lensUrl('raindrop-bookmark-v2');
    out[solid] = JSON.stringify({ ...JSON.parse(out[solid]), lensFormat: 9 });
    out[raindrop] = JSON.stringify({
      ...JSON.parse(out[raindrop]),
      '@id': 'https://elsewhere.example/lens',
    });
    const { lenses, skipped } = await fetchLensCatalog(
      releaseUrl('v2'),
      serve(out),
    );

    expect(lenses).toHaveLength(2);
    expect(skipped.map(s => s.subject).sort()).toEqual([raindrop, solid]);
  });

  it('caches per release URL', async () => {
    const fetch = serve(files('v2'));
    const first = await loadLensCatalog(releaseUrl('v2'), fetch);
    const calls = fetch.mock.calls.length;
    const second = await loadLensCatalog(releaseUrl('v2'), fetch);

    expect(second).toBe(first);
    expect(fetch.mock.calls.length).toBe(calls);
    expect(calls).toBe(1 + RELEASES.v2.length);
  });

  it('gives [] with a warning when the release cannot be fetched, and tries again next time', async () => {
    const down = vi.fn(async () => {
      throw new TypeError('Failed to fetch');
    });

    expect(await loadLensCatalog(releaseUrl('v2'), down)).toEqual([]);
    expect(console.warn).toHaveBeenCalled();
    expect(
      await loadLensCatalog(releaseUrl('v2'), serve(files('v2'))),
    ).toHaveLength(4);
  });

  it('does not cache a load that missed a lens file', async () => {
    const out = files('v2');
    delete out[lensUrl('solid-bookmark-v1')];

    expect(await loadLensCatalog(releaseUrl('v2'), serve(out))).toHaveLength(3);
    expect(
      await loadLensCatalog(releaseUrl('v2'), serve(files('v2'))),
    ).toHaveLength(4);
  });

  it('loads nothing and fetches nothing while the split-pieces flag is off', async () => {
    storage.delete(PIECES_FLAG_KEY);
    const fetch = serve(files('v2'));
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
