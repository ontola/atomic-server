import { describe, expect, it } from 'vitest';
import { classes } from './urls.js';
import { isGroupMember, MAX_GROUPS_VISITED } from './group-membership.js';
import { Resource } from './resource.js';
import type { Store } from './store.js';

const MEMBERS = 'https://atomicdata.dev/properties/group/members';
const WRITE = 'https://atomicdata.dev/properties/write';
const ME = 'did:ad:agent:me';

type Fake = { isGroup: boolean; members?: string[] };

function fakeStore(groups: Record<string, Fake>) {
  const fetched: string[] = [];

  return {
    fetched,
    getResource: async (subject: string) => {
      fetched.push(subject);
      const g = groups[subject];

      if (!g) throw new Error('not found');

      return {
        hasClasses: (...c: string[]) => g.isGroup && c.includes(classes.group),
        get: (p: string) => (p === MEMBERS ? g.members : undefined),
      };
    },
  };
}

describe('isGroupMember', () => {
  it('finds direct and nested members', async () => {
    const store = fakeStore({
      a: { isGroup: true, members: ['b'] },
      b: { isGroup: true, members: ['did:ad:agent:other', ME] },
    });

    expect(await isGroupMember(store, 'a', ME)).toBe(true);
    expect(await isGroupMember(store, 'a', 'did:ad:agent:nobody')).toBe(false);
  });

  it('terminates on cycles and grants nothing extra', async () => {
    const store = fakeStore({
      a: { isGroup: true, members: ['b', 'a'] },
      b: { isGroup: true, members: ['a'] },
    });

    expect(await isGroupMember(store, 'a', ME)).toBe(false);
    expect(store.fetched).toEqual(['a', 'b']);
  });

  it('ignores non-groups and unfetchable entries', async () => {
    const store = fakeStore({ t: { isGroup: false, members: [ME] } });

    expect(await isGroupMember(store, 't', ME)).toBe(false);
    expect(await isGroupMember(store, 'missing', ME)).toBe(false);
  });

  it('stops at the visit cap and fails closed', async () => {
    const groups: Record<string, Fake> = {};
    const n = MAX_GROUPS_VISITED + 10;

    for (let i = 0; i < n; i++) {
      groups[`g${i}`] = {
        isGroup: true,
        members: i === n - 1 ? [ME] : [`g${i + 1}`],
      };
    }

    const store = fakeStore(groups);

    expect(await isGroupMember(store, 'g0', ME)).toBe(false);
    expect(store.fetched.length).toBe(MAX_GROUPS_VISITED);
  });
});

describe('Resource.canWrite with groups', () => {
  function resourceWith(write: string[], groups: Record<string, Fake>) {
    const store = fakeStore(groups);
    const resource = new Resource('did:ad:doc');

    resource.setStore(store as unknown as Store);
    resource.get = ((p: string) => (p === WRITE ? write : undefined)) as never;

    return { resource, store };
  }

  it('allows writing through a group', async () => {
    const { resource } = resourceWith(['g'], {
      g: { isGroup: true, members: [ME] },
    });

    expect((await resource.canWrite(ME))[0]).toBe(true);
  });

  it('denies a non-member and does not fetch for plain agent grants', async () => {
    const a = resourceWith(['g'], { g: { isGroup: true, members: [] } });

    expect((await a.resource.canWrite(ME))[0]).toBe(false);

    const b = resourceWith(['did:ad:agent:other'], {});

    expect((await b.resource.canWrite(ME))[0]).toBe(false);
    expect(b.store.fetched).toEqual([]);
  });
});
