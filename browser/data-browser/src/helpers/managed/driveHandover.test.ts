// @vitest-environment jsdom
// @wc-ignore-file
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { core, server } from '@tomic/react';
import {
  applyPendingDriveHandover,
  handOverDrives,
  PENDING_DRIVE_HANDOVER_KEY,
  readPendingDriveHandover,
  type HandoverResource,
} from './driveHandover';

const guest = 'did:ad:agent:local';
const account = 'did:ad:agent:account';

type Fake = HandoverResource & {
  props: Record<string, unknown>;
  save: ReturnType<typeof vi.fn>;
};

/** A resource whose `write` decides `canWrite`, like the real one. */
function fake(props: Record<string, unknown>, error?: Error): Fake {
  const resource: Fake = {
    props,
    error,
    get: property => resource.props[property],
    push: (property, values, unique) => {
      const current = (resource.props[property] as string[]) ?? [];
      resource.props[property] = [
        ...current,
        ...values.filter(v => !unique || !current.includes(v)),
      ];
    },
    canWrite: async agent => [
      ((resource.props[core.properties.write] as string[]) ?? []).includes(
        agent ?? '',
      ),
      undefined,
    ],
    save: vi.fn(async () => {}),
  };

  return resource;
}

function fixture(resources: Record<string, Fake>, localOnly: string[] = []) {
  return {
    getResource: vi.fn(
      async (subject: string) =>
        resources[subject] ?? fake({}, new Error('not found')),
    ),
    isLocalOnlyDrive: (subject: string) => localOnly.includes(subject),
  };
}

const owned = (extra: Record<string, unknown> = {}) =>
  fake({ [core.properties.write]: [guest], ...extra });

beforeEach(() => localStorage.clear());

describe('handing drives to the account identity', () => {
  it('grants write on every owned drive except demo and preview drives', async () => {
    const resources: Record<string, Fake> = {
      [guest]: fake({ [core.properties.personalDrive]: 'did:ad:home' }),
      'did:ad:home': owned({
        [server.properties.drives]: [
          'did:ad:kept',
          'did:ad:demo',
          'did:ad:preview',
          'did:ad:shared',
          'did:ad:gone',
        ],
      }),
      'did:ad:kept': owned(),
      'did:ad:demo': owned(),
      'did:ad:preview': owned(),
      // Only shared with the guest for reading: not theirs to give.
      'did:ad:shared': fake({ [core.properties.read]: [guest] }),
    };
    const archive = vi.fn(async () => {});

    const pending = await handOverDrives(fixture(resources), {
      from: guest,
      to: account,
      skip: ['did:ad:demo', 'did:ad:preview', undefined],
      archiveIdentity: archive,
    });

    for (const drive of ['did:ad:home', 'did:ad:kept']) {
      expect(resources[drive].get(core.properties.write)).toContain(account);
      expect(resources[drive].save).toHaveBeenCalledOnce();
    }

    for (const drive of ['did:ad:demo', 'did:ad:preview', 'did:ad:shared']) {
      expect(resources[drive].get(core.properties.write) ?? []).not.toContain(
        account,
      );
      expect(resources[drive].save).not.toHaveBeenCalled();
    }

    expect(pending).toEqual({
      agent: account,
      drives: ['did:ad:home', 'did:ad:kept'],
    });
    expect(readPendingDriveHandover()).toEqual(pending);
    expect(archive).toHaveBeenCalledExactlyOnceWith(guest, []);
  });

  it('keeps local-only drives with the archived identity, not the account home', async () => {
    const resources = {
      [guest]: fake({ [core.properties.personalDrive]: 'did:ad:home' }),
      'did:ad:home': owned({ [server.properties.drives]: ['did:ad:kept'] }),
      'did:ad:kept': owned(),
    };
    const archive = vi.fn(async () => {});

    const pending = await handOverDrives(fixture(resources, ['did:ad:kept']), {
      from: guest,
      to: account,
      skip: [],
      archiveIdentity: archive,
    });

    expect(resources['did:ad:kept'].get(core.properties.write)).toContain(
      account,
    );
    expect(pending.drives).toEqual(['did:ad:home']);
    expect(archive).toHaveBeenCalledExactlyOnceWith(guest, ['did:ad:kept']);
  });

  it('carries local-only drives over after granting write, before keeping the key', async () => {
    const resources = {
      [guest]: fake({ [core.properties.personalDrive]: 'did:ad:home' }),
      'did:ad:home': owned({ [server.properties.drives]: ['did:ad:kept'] }),
      'did:ad:kept': owned(),
    };
    const order: string[] = [];
    const carryOver = vi.fn(async (drives: string[]) => {
      // The copy must carry the account's write grant.
      expect(resources['did:ad:kept'].get(core.properties.write)).toContain(
        account,
      );
      order.push(`carry ${drives.join(' ')}`);
    });

    const pending = await handOverDrives(
      fixture(resources, ['did:ad:home', 'did:ad:kept']),
      {
        from: guest,
        to: account,
        skip: [],
        carryOver,
        archiveIdentity: async () => {
          order.push('archive');
        },
      },
    );

    expect(order).toEqual(['carry did:ad:home did:ad:kept', 'archive']);
    // Listed once imported, not before.
    expect(pending.drives).toEqual([]);
  });

  it('fails, keeping nothing aside, when carrying over fails', async () => {
    const resources = {
      [guest]: fake({ [core.properties.personalDrive]: 'did:ad:home' }),
      'did:ad:home': owned(),
    };
    const archive = vi.fn(async () => {});

    await expect(
      handOverDrives(fixture(resources, ['did:ad:home']), {
        from: guest,
        to: account,
        skip: [],
        carryOver: async () => {
          throw new Error('too large');
        },
        archiveIdentity: archive,
      }),
    ).rejects.toThrow('too large');
    expect(archive).not.toHaveBeenCalled();
    expect(readPendingDriveHandover()).toBeUndefined();
  });

  it('is idempotent', async () => {
    const resources = {
      [guest]: fake({ [core.properties.personalDrive]: 'did:ad:home' }),
      'did:ad:home': owned(),
    };
    const store = fixture(resources);
    const options = {
      from: guest,
      to: account,
      skip: [],
      archiveIdentity: vi.fn(async () => {}),
    };

    const [first, concurrent] = await Promise.all([
      handOverDrives(store, options),
      handOverDrives(store, options),
    ]);
    const again = await handOverDrives(store, options);

    expect(concurrent).toBe(first);
    expect(again).toEqual(first);
    expect(resources['did:ad:home'].get(core.properties.write)).toEqual([
      guest,
      account,
    ]);
    expect(resources['did:ad:home'].save).toHaveBeenCalledOnce();
  });

  it('falls back to the recorded home when the agent cannot be read', async () => {
    const resources = { 'did:ad:home': owned() };

    const pending = await handOverDrives(fixture(resources), {
      from: guest,
      to: account,
      personalDrive: 'did:ad:home',
      skip: [],
      archiveIdentity: vi.fn(async () => {}),
    });

    expect(pending.drives).toEqual(['did:ad:home']);
  });

  it('fails, recording nothing, when a known home cannot be read', async () => {
    const resources = {
      [guest]: fake({ [core.properties.personalDrive]: 'did:ad:home' }),
    };
    const archive = vi.fn(async () => {});

    await expect(
      handOverDrives(fixture(resources), {
        from: guest,
        to: account,
        skip: [],
        archiveIdentity: archive,
      }),
    ).rejects.toThrow();
    expect(archive).not.toHaveBeenCalled();
    expect(readPendingDriveHandover()).toBeUndefined();
  });

  it('fails when the key cannot be kept', async () => {
    const resources = {
      [guest]: fake({ [core.properties.personalDrive]: 'did:ad:home' }),
      'did:ad:home': owned(),
    };

    await expect(
      handOverDrives(fixture(resources), {
        from: guest,
        to: account,
        skip: [],
        archiveIdentity: async () => {
          throw new Error('no stored key');
        },
      }),
    ).rejects.toThrow('no stored key');
    expect(readPendingDriveHandover()).toBeUndefined();
  });
});

describe('listing handed-over drives after the switch', () => {
  function pending(drives: string[], agent = account) {
    localStorage.setItem(
      PENDING_DRIVE_HANDOVER_KEY,
      JSON.stringify({ agent, drives }),
    );
  }

  it('adds the drives to the new home and clears the record', async () => {
    pending(['did:ad:home', 'did:ad:kept']);
    const home = fake({ [server.properties.drives]: ['did:ad:other'] });
    const store = fixture({
      [account]: fake({
        [core.properties.personalDrive]: 'did:ad:accounthome',
      }),
      'did:ad:accounthome': home,
    });

    expect(await applyPendingDriveHandover(store, account)).toBe(true);
    expect(home.get(server.properties.drives)).toEqual([
      'did:ad:other',
      'did:ad:home',
      'did:ad:kept',
    ]);
    expect(home.save).toHaveBeenCalledOnce();
    expect(localStorage.getItem(PENDING_DRIVE_HANDOVER_KEY)).toBeNull();

    // Nothing left to do the second time.
    expect(await applyPendingDriveHandover(store, account)).toBe(false);
    expect(home.save).toHaveBeenCalledOnce();
  });

  it('lists carried-over drives once they are imported', async () => {
    pending(['did:ad:synced']);
    const home = fake({});
    const store = fixture({
      [account]: fake({
        [core.properties.personalDrive]: 'did:ad:accounthome',
      }),
      'did:ad:accounthome': home,
    });
    const importCarried = vi.fn(async () => ['did:ad:home', 'did:ad:kept']);

    expect(await applyPendingDriveHandover(store, account, importCarried)).toBe(
      true,
    );
    expect(importCarried).toHaveBeenCalledWith(account);
    expect(home.get(server.properties.drives)).toEqual([
      'did:ad:synced',
      'did:ad:home',
      'did:ad:kept',
    ]);
  });

  it('lists carried-over drives with no other record', async () => {
    const home = fake({});
    const store = fixture({
      [account]: fake({
        [core.properties.personalDrive]: 'did:ad:accounthome',
      }),
      'did:ad:accounthome': home,
    });

    expect(
      await applyPendingDriveHandover(store, account, async () => [
        'did:ad:kept',
      ]),
    ).toBe(true);
    expect(home.get(server.properties.drives)).toEqual(['did:ad:kept']);
  });

  it('still lists synced drives when the import fails', async () => {
    pending(['did:ad:synced']);
    const home = fake({});
    const store = fixture({
      [account]: fake({
        [core.properties.personalDrive]: 'did:ad:accounthome',
      }),
      'did:ad:accounthome': home,
    });
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    expect(
      await applyPendingDriveHandover(store, account, async () => {
        throw new Error('database closed');
      }),
    ).toBe(true);
    expect(home.get(server.properties.drives)).toEqual(['did:ad:synced']);
  });

  it('waits for the identity the drives were handed to', async () => {
    pending(['did:ad:home']);
    const store = fixture({});

    expect(await applyPendingDriveHandover(store, guest)).toBe(false);
    expect(store.getResource).not.toHaveBeenCalled();
    expect(readPendingDriveHandover()).toBeDefined();
  });

  it('keeps the record for a retry when the home cannot be saved', async () => {
    pending(['did:ad:home']);
    const home = fake({});
    home.save.mockRejectedValueOnce(new Error('offline'));
    const store = fixture({
      [account]: fake({
        [core.properties.personalDrive]: 'did:ad:accounthome',
      }),
      'did:ad:accounthome': home,
    });
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    expect(await applyPendingDriveHandover(store, account)).toBe(false);
    expect(readPendingDriveHandover()).toBeDefined();
  });
});
