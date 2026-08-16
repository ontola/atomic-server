import type { Store } from '@tomic/react';
import { getOrCreateFolderByLocalId } from './folderByLocalId';

/** Well-known id of the per-drive Forks folder, resolved via `localId`. */
const FORKS_LOCAL_ID = 'forks';

/**
 * The drive's Forks folder, created on first use.
 *
 * Forks are kept out of the publicly readable part of a drive by *living*
 * somewhere the public cannot read — a folder is private precisely when it
 * carries no public read grant. So a fork is only as private as this folder is:
 * on a drive that is itself publicly readable, everything in it is public, and
 * this folder does not pretend otherwise.
 */
export async function getOrCreateForksFolder(
  store: Store,
  drive: string,
): Promise<string> {
  return getOrCreateFolderByLocalId(store, drive, FORKS_LOCAL_ID, {
    name: 'Forks',
    description:
      'Work in progress. Resources here are visible to people who can write to this drive, and are published by moving them somewhere publicly readable.',
  });
}
