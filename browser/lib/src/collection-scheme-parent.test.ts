import { describe, expect, it } from 'vitest';
import { Collection } from './collection.js';
import { collections, core } from './index.js';
import { Resource } from './resource.js';
import { Store } from './store.js';

/**
 * A private drive is named after the agent key, and the same id exists as
 * `atomic:` and as the legacy `did:ad:`. A child written before the rename
 * names its parent in the old form, and the query for the drive's children is
 * asked in the new one (or the other way round). The server answers both, so
 * the child is a member; the live-membership check compared the two strings
 * as they were, read the child as no longer matching and stripped it from the
 * page it had just been answered with. A refresh put it back, and the drive's
 * children list flipped between the two states for as long as it was open.
 */
const DRIVE = 'atomic:W2Q3ABCDEF';
const LEGACY_DRIVE = 'did:ad:W2Q3ABCDEF';
const CHILD = 'atomic:resource:child';

type Internals = {
  pages: Map<number, Resource>;
  writePageMembers(page: Resource, members: string[], total: number): void;
  setPage(page: number, r: Resource): void;
  _totalMembers: number;
};

describe('Collection filtered on parent', () => {
  it.each([
    ['atomic: query, did:ad: parent', DRIVE, LEGACY_DRIVE],
    ['did:ad: query, atomic: parent', LEGACY_DRIVE, DRIVE],
  ])(
    'keeps a member naming the drive in the other scheme (%s)',
    (_name, query, parent) => {
      const store = new Store({ serverUrl: 'https://example.com' });
      const collection = new Collection(
        store,
        'https://example.com',
        {
          page_size: '50',
          include_nested: false,
          property: core.properties.parent,
          value: query,
        },
        true,
      );
      const internals = collection as unknown as Internals;
      const answered = new Resource<never>('https://example.com/answer');
      internals.writePageMembers(answered as unknown as Resource, [CHILD], 1);
      internals.setPage(0, answered as unknown as Resource);
      internals._totalMembers = 1;

      const child = new Resource(CHILD);
      child.loading = false;
      child.set(core.properties.parent, parent as never);

      expect(collection.applyResourceChange(CHILD, child)).toBe('unchanged');
      expect(
        internals.pages.get(0)?.getSubjects(collections.properties.members),
      ).toEqual([CHILD]);
      expect(collection.totalMembers).toBe(1);
    },
  );
});
