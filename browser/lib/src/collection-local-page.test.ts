import { describe, it, expect as assert, vi } from 'vitest';
import { Collection } from './collection.js';
import type {
  ClientDbQueryOpts,
  ClientDbQueryResult,
  ClientDbWorker,
} from './client-db.js';
import { commits, collections, core, dataBrowser } from './index.js';
import { Resource } from './resource.js';
import { Store } from './store.js';

/**
 * The table-open cliff was Collection asking WASM for every match with
 * JSON-AD bodies, then sorting and slicing in JS. The worker already
 * accepts `limit` / `offset` / `sortBy`; these pin that we pass them and
 * that `totalMembers` stays the full count when the store pages.
 */

const TABLE = 'did:ad:resource:table';
const DRIVE = 'did:ad:resource:drive';
const PAGE = 30;

function jsonAd(subject: string, createdAt: number): string {
  return JSON.stringify({
    '@id': subject,
    [core.properties.parent]: TABLE,
    [core.properties.isA]: [dataBrowser.classes.folder],
    [core.properties.name]: subject.slice('did:ad:resource:'.length),
    [commits.properties.createdAt]: createdAt,
  });
}

function subjects(n: number): string[] {
  return Array.from({ length: n }, (_, i) => `did:ad:resource:row-${i}`);
}

function pagedClientDb(all: string[]): {
  clientDb: ClientDbWorker;
  calls: ClientDbQueryOpts[];
} {
  const calls: ClientDbQueryOpts[] = [];

  const clientDb = {
    isReady: true,
    waitForReady: async () => true,
    query: async (opts: ClientDbQueryOpts): Promise<ClientDbQueryResult> => {
      calls.push(opts);

      const offset = opts.offset ?? 0;
      const limit = opts.limit;
      const slice =
        limit === undefined ? all : all.slice(offset, offset + limit);

      return {
        subjects: slice,
        resources: opts.includeResources
          ? slice.map((s, i) => jsonAd(s, offset + i))
          : [],
        count: all.length,
      };
    },
  } as unknown as ClientDbWorker;

  return { clientDb, calls };
}

function pageMembers(collection: Collection): string[] {
  const pages = (
    collection as unknown as {
      pages: Map<number, Resource>;
    }
  ).pages;
  const page = pages.get(0);

  if (!page) return [];

  return page.getSubjects(collections.properties.members);
}

describe('Collection local fetch pages in the store', () => {
  it('asks the worker for a sorted page of bodies, not every match', async () => {
    const all = subjects(90);
    const { clientDb, calls } = pagedClientDb(all);
    const store = new Store({ serverUrl: 'https://example.com' });
    store.setDrive(DRIVE);
    store.finishDriveSync(DRIVE, 3, Date.now());
    store.setClientDb(clientDb);

    const collection = new Collection(store, 'https://example.com', {
      page_size: String(PAGE),
      include_nested: false,
      property: core.properties.parent,
      value: TABLE,
      filters: [
        { property: core.properties.isA, value: dataBrowser.classes.folder },
      ],
      sort_by: commits.properties.createdAt,
      sort_desc: false,
      drive: DRIVE,
    });
    await collection.waitForReady();

    const bodies = calls.filter(c => c.includeResources);
    const membership = calls.filter(c => c.includeResources === false);

    assert(bodies).toHaveLength(1);
    assert(bodies[0]!.limit).toBe(PAGE);
    assert(bodies[0]!.offset).toBe(0);
    assert(bodies[0]!.sortBy).toBe(commits.properties.createdAt);
    assert(bodies[0]!.drive).toBe(DRIVE);
    assert(membership).toHaveLength(1);
    assert(membership[0]!.limit).toBeUndefined();
    assert(collection.totalMembers).toBe(90);
    assert(pageMembers(collection)).toEqual(all.slice(0, PAGE));
    assert(await collection.getMemberWithIndex(0)).toBe(all[0]);
    assert(await collection.getMemberWithIndex(89)).toBe(all[89]);

    const pageTwo = calls.filter(c => c.includeResources && c.offset === 60);

    assert(pageTwo).toHaveLength(1);
    assert(pageTwo[0]!.limit).toBe(PAGE);
  });

  it('does not hydrate off-page bodies', async () => {
    const all = subjects(90);
    const { clientDb } = pagedClientDb(all);
    const store = new Store({ serverUrl: 'https://example.com' });
    store.setDrive(DRIVE);
    store.finishDriveSync(DRIVE, 3, Date.now());
    store.setClientDb(clientDb);
    const hydrate = vi.spyOn(store, 'hydrateResourceFromJsonAd');

    const collection = new Collection(store, 'https://example.com', {
      page_size: String(PAGE),
      include_nested: false,
      property: core.properties.parent,
      value: TABLE,
      sort_by: commits.properties.createdAt,
      drive: DRIVE,
    });
    await collection.waitForReady();

    assert(collection.totalMembers).toBe(90);
    assert(hydrate.mock.calls.map(([subject]) => subject)).toEqual(
      all.slice(0, PAGE),
    );
  });
});
