import { CollectionBuilder, core, dataBrowser, type Store } from '@tomic/react';

/** Well-known id of the per-drive Drafts folder, resolved via `localId`. */
const DRAFTS_LOCAL_ID = 'drafts';

/**
 * The drive's Drafts folder, created on first use.
 *
 * Drafts are kept out of the publicly readable part of a drive by *living*
 * somewhere the public cannot read — a folder is private precisely when it
 * carries no public read grant. So a draft is only as private as this folder is:
 * on a drive that is itself publicly readable, everything in it is public, and
 * this folder does not pretend otherwise.
 */
export async function getOrCreateDraftsFolder(
  store: Store,
  drive: string,
): Promise<string> {
  const collection = await new CollectionBuilder(store)
    .setDrive(drive)
    .setProperty(core.properties.localId)
    .setValue(DRAFTS_LOCAL_ID)
    .setPageSize(1)
    .buildAndFetch();

  // `getMemberWithIndex` throws when the collection is empty, which is exactly
  // the first-use case, so check the count before asking for a member.
  if (collection.totalMembers > 0) {
    const existing = await collection.getMemberWithIndex(0);

    if (existing) {
      return existing;
    }
  }

  const folder = await store.newResource({
    parent: drive,
    isA: dataBrowser.classes.folder,
    propVals: {
      [core.properties.name]: 'Drafts',
      [core.properties.localId]: DRAFTS_LOCAL_ID,
      [core.properties.description]:
        'Work in progress. Resources here are visible to people who can write to this drive, and are published by moving them somewhere publicly readable.',
    },
  });

  await folder.save();

  return folder.subject;
}
