import { LoroDoc } from 'loro-crdt';
import {
  core,
  dataBrowser,
  enableLoro,
  isPropertySubject,
  type Resource,
  type Store,
} from '@tomic/react';
import {
  readVaultSnapshot,
  restoreDrive,
  restoreDriveBlobs,
  type BlobRestoreOutcome,
  type RestoreOutcome,
  type ScratchVaultDb,
  type VaultCapableDb,
} from './vault';

type Json = unknown;

/** Root containers a doc may or may not have created yet carry no state. */
function withoutEmptyRoots(json: Json): Json {
  if (!json || typeof json !== 'object') return json;

  return Object.fromEntries(
    Object.entries(json).filter(([, value]) => {
      if (value && typeof value === 'object') {
        return Object.keys(value).length > 0;
      }

      return value !== '' && value !== undefined;
    }),
  );
}

function sameJson(a: Json, b: Json): boolean {
  if (a === b) return true;

  if (!a || !b || typeof a !== 'object' || typeof b !== 'object') return false;

  if (Array.isArray(a) !== Array.isArray(b)) return false;

  const keysA = Object.keys(a);

  return (
    keysA.length === Object.keys(b).length &&
    keysA.every(
      key =>
        key in b &&
        sameJson(
          (a as Record<string, Json>)[key],
          (b as Record<string, Json>)[key],
        ),
    )
  );
}

function sameState(a: LoroDoc, b: LoroDoc): boolean {
  return sameJson(withoutEmptyRoots(a.toJSON()), withoutEmptyRoots(b.toJSON()));
}

/** Whether `doc` holds every operation the frontiers name. */
function knowsFrontiers(
  doc: LoroDoc,
  frontiers: ReturnType<LoroDoc['frontiers']>,
) {
  const seen = doc.oplogVersion().toJSON();

  return frontiers.every(f => (seen.get(f.peer) ?? 0) > f.counter);
}

/**
 * Make `doc` hold exactly the state of `snapshot`, as one new local change.
 *
 * `revertTo` writes new operations on top of the existing history instead of
 * rewinding it, so the change merges and syncs like any edit and a later undo
 * or the History page still sees what was there before. When the snapshot is an
 * older point of this very doc (the normal case) nothing is imported; only when
 * `doc` lacks the snapshot's operations are they imported first, which
 * `revertTo` needs in order to name the version it returns to.
 *
 * Throws, leaving `doc` unchanged, when the result would not equal the
 * snapshot, rather than keeping an approximation. Returns whether it changed.
 */
export function revertDocToSnapshot(
  doc: LoroDoc,
  snapshot: Uint8Array,
): { changed: boolean; imported: boolean } {
  const target = new LoroDoc();

  target.import(snapshot);

  if (sameState(doc, target)) return { changed: false, imported: false };

  const frontiers = target.frontiers();
  const imported = !knowsFrontiers(doc, frontiers);
  // Rehearse on a copy: a failure must not leave half a revert in the doc.
  const probe = doc.fork();

  if (imported) probe.import(snapshot);

  probe.revertTo(frontiers);

  if (!sameState(probe, target)) {
    throw new Error('The state of this snapshot could not be rebuilt exactly.');
  }

  if (imported) doc.import(snapshot);

  doc.revertTo(frontiers);

  return { changed: true, imported };
}

/**
 * Resources that exist now but not in the snapshot, reduced to the ones that
 * need moving: anything under another new resource goes along with it.
 */
export function newTopLevelSubjects(
  current: string[],
  snapshot: Set<string>,
  parentOf: (subject: string) => string | undefined,
): string[] {
  const added = current.filter(subject => !snapshot.has(subject));
  const addedSet = new Set(added);

  return added.filter(subject => {
    const parent = parentOf(subject);

    return !parent || !addedSet.has(parent);
  });
}

const BLOB_PROP = 'https://atomicdata.dev/properties/blob';
const INTERNAL_ID_PROP = 'https://atomicdata.dev/properties/internalId';

/**
 * The files a snapshot's File resources reference: plain BLAKE3 hashes from
 * `internalId`. The snapshot, not the drive as it is now, decides which file
 * bytes a restore to it needs.
 */
export function snapshotFileHashes(states: Iterable<Uint8Array>): string[] {
  const hashes = new Set<string>();

  for (const bytes of states) {
    const doc = new LoroDoc();

    doc.import(bytes);
    const properties = doc.getMap('properties').toJSON() as Record<
      string,
      unknown
    >;
    const id = properties[INTERNAL_ID_PROP];

    if (
      properties[BLOB_PROP] !== undefined &&
      typeof id === 'string' &&
      /^[0-9a-fA-F]{64}$/.test(id)
    ) {
      hashes.add(id.toLowerCase());
    }
  }

  return [...hashes];
}

export type SnapshotRestoreOutcome = RestoreOutcome & {
  /** Resources whose state was rewritten to the snapshot's. */
  reverted: number;
  /** File bytes of the snapshot's files. Absent when the db cannot store files. */
  blobs?: BlobRestoreOutcome;
};

/**
 * Overwrite a drive with the state it had at a snapshot.
 *
 * The overwrite is written as new changes to the drive's live resources and
 * saved through the normal resource path, so it syncs to the server and to
 * every other device like any edit. Nothing is hard-deleted:
 * - resources in the snapshot are reverted to it (which also takes them out of
 *   the Trash if they sit there now, since the Trash is just a parent);
 * - resources the snapshot lacks are moved to the Trash;
 * - resources the snapshot has but this device no longer holds are imported
 *   from the snapshot's checkpoint as they were.
 */
export async function restoreDriveToSnapshot({
  store,
  db,
  drive,
  drivePseudonym,
  devicePubkey,
  driveKey,
  keyEpoch,
  snapshotId,
  openScratchDb,
  listDriveSubjects,
  onProgress,
}: {
  store: Store;
  db: VaultCapableDb;
  drive: string;
  drivePseudonym: string;
  devicePubkey: string;
  driveKey: Uint8Array;
  keyEpoch: number;
  snapshotId: string;
  openScratchDb: () => Promise<ScratchVaultDb>;
  listDriveSubjects: (drive: string) => Promise<string[]>;
  /** 0 to 1 over reading the snapshot and applying it. */
  onProgress?: (fraction: number) => void;
}): Promise<SnapshotRestoreOutcome> {
  await enableLoro();

  const { state, sealed } = await readVaultSnapshot({
    drivePseudonym,
    snapshotId,
    driveKey,
    keyEpoch,
    devicePubkey,
    openScratchDb,
    onProgress: (done, total) => onProgress?.(0.2 * (total ? done / total : 1)),
  });
  const current = (await listDriveSubjects(drive)).map(pureId);
  const currentSet = new Set(current);
  const snapshots = new Map([...state].map(([k, bytes]) => [pureId(k), bytes]));
  const wanted = [...snapshots.keys()];
  const wantedSet = new Set(wanted);
  const missing = wanted.filter(subject => !currentSet.has(subject));

  const outcome: SnapshotRestoreOutcome = {
    packsRead: 0,
    resourcesRestored: 0,
    tombstonesApplied: 0,
    objectsSkipped: 0,
    objectsUnreadable: 0,
    reverted: 0,
  };

  if (missing.length > 0) {
    const imported = await restoreDrive({
      db,
      drivePseudonym,
      devicePubkey,
      driveKey,
      keyEpoch,
      source: async () => [sealed],
    });

    outcome.packsRead = imported.packsRead;
    outcome.resourcesRestored += missing.length;
  }

  const failures: string[] = [];
  const present = wanted.filter(subject => currentSet.has(subject));
  const parents = new Map<string, string | undefined>();
  let done = 0;

  for (const subject of present) {
    try {
      const changed = await revertResource(
        store,
        drive,
        subject,
        snapshots.get(subject)!,
      );

      if (changed) outcome.reverted++;
    } catch (e) {
      failures.push(`${subject}: ${(e as Error).message}`);
    }

    onProgress?.(0.2 + 0.7 * (++done / Math.max(1, present.length)));
  }

  outcome.resourcesRestored += outcome.reverted;

  // Only now that the snapshot's own resources are back: what is new since is
  // moved aside, not deleted, so the person can still fetch it from the Trash.
  const added = current.filter(subject => !wantedSet.has(subject));
  // The Trash is where these go, so it is never one of them.
  const trashFolder = (await store.getResource(drive)).get(
    dataBrowser.properties.trashFolder,
  ) as string | undefined;

  for (const subject of added) {
    try {
      parents.set(
        subject,
        (await store.getResource(subject)).get(core.properties.parent) as
          | string
          | undefined,
      );
    } catch (e) {
      failures.push(`${subject}: ${(e as Error).message}`);
    }
  }

  for (const subject of newTopLevelSubjects(current, wantedSet, s =>
    parents.get(s),
  )) {
    if (
      subject === trashFolder ||
      !parents.has(subject) ||
      isPropertySubject(subject)
    )
      continue;

    try {
      if (await store.trash(subject, drive)) outcome.tombstonesApplied++;
    } catch (e) {
      failures.push(`${subject}: ${(e as Error).message}`);
    }
  }

  // The snapshot's resources name its files; their bytes come from the vault.
  // Done before reporting failures so a partial restore still brings back the
  // files it can.
  outcome.blobs = await restoreDriveBlobs({
    db,
    driveSubject: drive,
    drivePseudonym,
    driveKey,
    keyEpoch,
    hashes: snapshotFileHashes(snapshots.values()),
  });

  onProgress?.(1);

  if (failures.length > 0) {
    throw new Error(
      `${failures.length} items could not be restored (${failures[0]}). The rest was restored.`,
    );
  }

  return outcome;
}

/** `pure_id()` of a subject: without the query the database may append. */
function pureId(subject: string): string {
  return subject.split('?')[0];
}

/**
 * Revert one resource through its live doc and save it. The drive's Trash
 * folder is kept as it is now: it is where this restore puts things.
 */
async function revertResource(
  store: Store,
  drive: string,
  subject: string,
  snapshot: Uint8Array,
): Promise<boolean> {
  const resource: Resource = await store.getResource(subject);
  const doc = resource.getLoroDoc();

  if (!doc) throw new Error('Loro is not available.');

  const trash = resource.get(dataBrowser.properties.trashFolder) as
    | string
    | undefined;

  resource.sealPendingEdits();

  // Rehearsed first by `revertDocToSnapshot`; marking dirty afterwards keeps a
  // refused revert from leaving an unsaved edit behind.
  const probe = new LoroDoc();

  probe.import(snapshot);

  if (sameState(doc, probe)) return false;

  resource.markDirty();

  const { imported } = revertDocToSnapshot(doc, snapshot);

  // Ops that arrived by import are not ours to sign; send the whole doc, which
  // the server accepts idempotently.
  if (imported) resource.clearLoroSaveCursor();

  await resource.save();

  if (
    subject === drive &&
    (resource.get(dataBrowser.properties.trashFolder) as string | undefined) !==
      trash
  ) {
    if (trash) await resource.set(dataBrowser.properties.trashFolder, trash);
    else resource.remove(dataBrowser.properties.trashFolder);

    await resource.save();
  }

  return true;
}
