// @wc-ignore-file
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LoroDoc } from 'loro-crdt';
import { core, dataBrowser } from '@tomic/react';
import {
  newTopLevelSubjects,
  restoreDriveToSnapshot,
  revertDocToSnapshot,
} from './vaultRestore';
import { readVaultSnapshot, type VaultCapableDb } from './vault';

vi.mock('loro-crdt', () => import('loro-crdt/nodejs'));
vi.mock('@tomic/react', async importOriginal => ({
  ...(await importOriginal<typeof import('@tomic/react')>()),
  enableLoro: async () => undefined,
}));

const PARENT = core.properties.parent;
const NAME = core.properties.name;
const TRASH = dataBrowser.properties.trashFolder;

function docWith(props: Record<string, string>, peer: string) {
  const doc = new LoroDoc();

  doc.setPeerId(peer as `${number}`);
  const map = doc.getMap('properties');

  for (const [k, v] of Object.entries(props)) map.set(k, v);

  doc.commit();

  return doc;
}

const props = (doc: LoroDoc) =>
  doc.getMap('properties').toJSON() as Record<string, string>;

describe('revertDocToSnapshot', () => {
  it('writes the older state as a new change on top of the newer history', () => {
    const doc = docWith({ [NAME]: 'Plan' }, '1');
    const snapshot = doc.export({ mode: 'snapshot' });
    const before = doc.oplogVersion().toJSON().get('1')!;

    doc.getMap('properties').set(NAME, 'Plan v2');
    doc.getMap('properties').set(PARENT, 'drive');
    doc.getText('body').insert(0, 'later words');
    doc.commit();

    const result = revertDocToSnapshot(doc, snapshot);

    expect(result).toEqual({ changed: true, imported: false });
    expect(props(doc)).toEqual({ [NAME]: 'Plan' });
    expect(doc.getText('body').toString()).toBe('');
    // New operations, not a rewind: history only grew.
    expect(doc.oplogVersion().toJSON().get('1')!).toBeGreaterThan(before + 1);
  });

  it('does nothing when the doc already equals the snapshot', () => {
    const doc = docWith({ [NAME]: 'Same' }, '1');
    const frontiers = doc.frontiers();

    expect(revertDocToSnapshot(doc, doc.export({ mode: 'snapshot' }))).toEqual({
      changed: false,
      imported: false,
    });
    expect(doc.frontiers()).toEqual(frontiers);
  });

  it('works from a shallow (current-state-only) snapshot', () => {
    const doc = docWith({ [NAME]: 'Old' }, '1');
    doc.getMap('properties').set(NAME, 'Older still');
    doc.getMap('properties').set(NAME, 'Kept');
    doc.commit();
    const shallow = doc.export({
      mode: 'shallow-snapshot',
      frontiers: doc.frontiers(),
    });

    doc.getMap('properties').set(NAME, 'Newer');
    doc.commit();

    expect(revertDocToSnapshot(doc, shallow).changed).toBe(true);
    expect(props(doc)[NAME]).toBe('Kept');
  });

  it('imports the snapshot first when the doc lacks its operations', () => {
    const origin = docWith({ [NAME]: 'Theirs' }, '1');
    const snapshot = origin.export({ mode: 'snapshot' });
    const doc = new LoroDoc();

    doc.setPeerId('2');
    doc.getMap('properties').set(PARENT, 'drive');
    doc.commit();

    expect(revertDocToSnapshot(doc, snapshot)).toEqual({
      changed: true,
      imported: true,
    });
    expect(props(doc)).toEqual({ [NAME]: 'Theirs' });
  });

  it('can be undone by reverting to the state it replaced', () => {
    const doc = docWith({ [NAME]: 'A' }, '1');
    const first = doc.export({ mode: 'snapshot' });

    doc.getMap('properties').set(NAME, 'B');
    doc.commit();
    const second = doc.export({ mode: 'snapshot' });

    revertDocToSnapshot(doc, first);
    revertDocToSnapshot(doc, second);

    expect(props(doc)[NAME]).toBe('B');
  });
});

describe('newTopLevelSubjects', () => {
  it('keeps new resources whose parent is not new itself', () => {
    const parents: Record<string, string> = {
      folder: 'drive',
      child: 'folder',
      loose: 'drive',
    };

    expect(
      newTopLevelSubjects(
        ['drive', 'old', 'folder', 'child', 'loose'],
        new Set(['drive', 'old']),
        s => parents[s],
      ),
    ).toEqual(['folder', 'loose']);
  });
});

/** A live resource backed by a real doc, as much of `Resource` as is used. */
function liveResource(subject: string, doc: LoroDoc) {
  const resource = {
    subject,
    saves: 0,
    getLoroDoc: () => doc,
    sealPendingEdits: () => doc.commit(),
    markDirty: vi.fn(),
    clearLoroSaveCursor: vi.fn(),
    get: (prop: string) => doc.getMap('properties').get(prop),
    set: async (prop: string, value: string) => {
      doc.getMap('properties').set(prop, value);
      doc.commit();
    },
    remove: (prop: string) => {
      doc.getMap('properties').delete(prop);
      doc.commit();
    },
    save: async () => {
      resource.saves++;
    },
  };

  return resource;
}

const PSEUDONYM = 'pseudo';
const DEVICE = '03'.repeat(32);
const KEY = new Uint8Array(32).fill(7);
const CKPT_KEY = `vault/${PSEUDONYM}/checkpoints/ckpt-000002.loro`;

describe('restoreDriveToSnapshot', () => {
  beforeEach(() => {
    vi.stubEnv('VITE_MANAGED_PORTAL_URL', 'https://control.test');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  /**
   * The snapshot: a drive with a note and a folder. Since then the note was
   * edited, the folder was trashed, a new page appeared (with a child) and an
   * untouched page stayed. A page the snapshot has was never loaded here.
   */
  function scenario() {
    const trash = 'trash';
    const snap = {
      drive: docWith({ [NAME]: 'Drive' }, '1'),
      note: docWith({ [NAME]: 'Note', [PARENT]: 'drive' }, '2'),
      folder: docWith({ [NAME]: 'Folder', [PARENT]: 'drive' }, '3'),
      same: docWith({ [NAME]: 'Same', [PARENT]: 'drive' }, '4'),
      gone: docWith({ [NAME]: 'Gone', [PARENT]: 'drive' }, '5'),
    };
    const state = new Map(
      Object.entries(snap).map(([k, d]) => [k, d.export({ mode: 'snapshot' })]),
    );
    // The live docs continue the same histories.
    const live = Object.fromEntries(
      ['drive', 'note', 'folder', 'same', 'gone'].map(k => {
        const d = new LoroDoc();

        d.import(state.get(k)!);

        return [k, d];
      }),
    );

    live.drive.getMap('properties').set(TRASH, trash);
    live.drive.getMap('properties').set(NAME, 'Renamed drive');
    live.note.getMap('properties').set(NAME, 'Note, edited');
    live.folder.getMap('properties').set('trashedFrom', 'drive');
    live.folder.getMap('properties').set(PARENT, trash);
    Object.values(live).forEach(d => d.commit());
    const added = docWith({ [NAME]: 'New page', [PARENT]: 'drive' }, '8');
    const addedChild = docWith({ [NAME]: 'Child', [PARENT]: 'added' }, '9');
    const trashFolder = docWith({ [NAME]: 'Trash', [PARENT]: 'drive' }, '7');

    const resources: Record<string, ReturnType<typeof liveResource>> = {
      ...Object.fromEntries(
        Object.entries(live).map(([k, d]) => [k, liveResource(k, d)]),
      ),
      gone: liveResource('gone', live.gone),
      added: liveResource('added', added),
      addedChild: liveResource('addedChild', addedChild),
      trash: liveResource(trash, trashFolder),
    };
    const trashed: string[] = [];
    const store = {
      getResource: async (s: string) => resources[s],
      trash: vi.fn(async (s: string) => {
        trashed.push(s);

        return true;
      }),
    };
    const db: VaultCapableDb = {
      vaultExport: vi.fn(),
      vaultCommitSegment: vi.fn(),
      vaultImport: vi.fn(async () => ({
        packsRead: 1,
        resourcesRestored: 1,
        tombstonesApplied: 0,
        objectsSkipped: 0,
        objectsUnreadable: 0,
      })),
    };
    const scratch = {
      vaultImport: vi.fn(async () => ({
        packsRead: 1,
        resourcesRestored: 5,
        tombstonesApplied: 0,
        objectsSkipped: 0,
        objectsUnreadable: 0,
      })),
      // The built-in vocabulary is there before the import and is not the drive.
      allSubjects: vi
        .fn()
        .mockReturnValueOnce(['builtin'])
        .mockReturnValue(['builtin', ...Object.keys(snap)]),
      getLoroSnapshot: (s: string) =>
        state.get(s) ?? (s === 'builtin' ? new Uint8Array([1]) : null),
      free: vi.fn(),
    };

    return { store, db, scratch, resources, trashed, state };
  }

  function mockVault() {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async input => {
      const url = String(input);

      if (url.endsWith('/state'))
        return new Response(
          JSON.stringify({
            checkpoints: [
              { id: 'snap-1', checkpoint_n: 1, checkpoint_object_id: 'o1' },
              { id: 'snap-2', checkpoint_n: 2, checkpoint_object_id: 'o2' },
            ],
          }),
        );
      if (url.endsWith('/objects'))
        return new Response(
          JSON.stringify([
            { object_id: 'o1', object_key: CKPT_KEY.replace('2', '1') },
            { object_id: 'o2', object_key: CKPT_KEY },
          ]),
        );
      if (url.endsWith('/download-urls'))
        return new Response(
          JSON.stringify({
            downloads: [
              {
                object_id: 'o2',
                object_key: CKPT_KEY,
                url: 'https://s3.test/o2',
              },
            ],
          }),
        );

      return new Response(new Uint8Array([9, 9]));
    });
  }

  const run = (s: ReturnType<typeof scenario>, listed: string[]) =>
    restoreDriveToSnapshot({
      store: s.store as never,
      db: s.db,
      drive: 'drive',
      drivePseudonym: PSEUDONYM,
      devicePubkey: DEVICE,
      driveKey: KEY,
      keyEpoch: 1,
      snapshotId: 'snap-2',
      openScratchDb: async () => s.scratch,
      listDriveSubjects: async () => listed,
    });

  it('maps the snapshot id to its checkpoint object and reads only that', async () => {
    mockVault();
    const s = scenario();
    const read = await readVaultSnapshot({
      drivePseudonym: PSEUDONYM,
      snapshotId: 'snap-2',
      driveKey: KEY,
      keyEpoch: 1,
      devicePubkey: DEVICE,
      openScratchDb: async () => s.scratch,
    });

    expect(read.sealed.objectKey).toBe(CKPT_KEY);
    expect([...read.state.keys()].sort()).toEqual(
      ['drive', 'folder', 'gone', 'note', 'same'].sort(),
    );
    expect(s.scratch.vaultImport).toHaveBeenCalledWith(
      KEY,
      1,
      PSEUDONYM,
      DEVICE,
      [{ objectKey: CKPT_KEY, sealed: new Uint8Array([9, 9]) }],
    );
    expect(s.scratch.free).toHaveBeenCalled();
  });

  it('refuses a snapshot that is no longer stored', async () => {
    mockVault();
    const s = scenario();

    await expect(
      readVaultSnapshot({
        drivePseudonym: PSEUDONYM,
        snapshotId: 'gone',
        driveKey: KEY,
        keyEpoch: 1,
        devicePubkey: DEVICE,
        openScratchDb: async () => s.scratch,
      }),
    ).rejects.toThrow(/no longer stored/);
  });

  it('reverts changed resources, untrashes, trashes the new and imports the missing', async () => {
    mockVault();
    const s = scenario();

    const outcome = await run(s, [
      'drive',
      'note',
      'folder',
      'same',
      'added',
      'addedChild',
      'trash',
    ]);

    const text = (k: string, p: string) => s.resources[k].get(p);

    // Edited and renamed back.
    expect(text('note', NAME)).toBe('Note');
    expect(text('drive', NAME)).toBe('Drive');
    // Untrashed: its parent is the snapshot's again.
    expect(text('folder', PARENT)).toBe('drive');
    expect(s.resources.folder.get('trashedFrom')).toBeUndefined();
    // The Trash folder the drive points at is kept, not reverted away.
    expect(text('drive', TRASH)).toBe('trash');
    // Untouched resources are not rewritten.
    expect(s.resources.same.saves).toBe(0);
    // New since the snapshot: only the top one moves, the Trash itself and the
    // child ride along.
    expect(s.trashed).toEqual(['added']);
    // Nothing is hard-deleted.
    expect(s.db.vaultImport).toHaveBeenCalledTimes(1);
    expect(outcome.reverted).toBe(3);
    expect(outcome.tombstonesApplied).toBe(1);
    // 'gone' was not on this device, so it came from the checkpoint object.
    expect(s.db.vaultImport).toHaveBeenCalledWith(KEY, 1, PSEUDONYM, DEVICE, [
      { objectKey: CKPT_KEY, sealed: new Uint8Array([9, 9]) },
    ]);
    expect(outcome.packsRead).toBe(1);
  });

  it('does not touch the live store when every resource is still here', async () => {
    mockVault();
    const s = scenario();

    await run(s, ['drive', 'note', 'folder', 'same', 'gone']);

    expect(s.db.vaultImport).toHaveBeenCalledTimes(0);
  });

  it('reports resources that could not be restored instead of hiding them', async () => {
    mockVault();
    const s = scenario();

    s.store.getResource = async (subject: string) => {
      if (subject === 'note') throw new Error('no write access');

      return s.resources[subject];
    };

    await expect(run(s, ['drive', 'note', 'folder', 'same'])).rejects.toThrow(
      /1 items could not be restored \(note: no write access\)/,
    );
    // The rest still went through.
    expect(s.resources.folder.get(PARENT)).toBe('drive');
  });
});
