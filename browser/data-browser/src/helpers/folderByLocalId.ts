import { CollectionBuilder, core, dataBrowser, type Store } from '@tomic/react';

/**
 * Resolve a well-known folder under `drive` by `localId`, creating it on
 * first use. Shared by Drafts, Forks, and Notifications — same query +
 * create shape; only the id and copy differ.
 */
export async function getOrCreateFolderByLocalId(
  store: Store,
  drive: string,
  localId: string,
  meta: { name: string; description: string },
): Promise<string> {
  const collection = await new CollectionBuilder(store)
    .setDrive(drive)
    .setProperty(core.properties.localId)
    .setValue(localId)
    .setPageSize(1)
    .buildAndFetch();

  // `getMemberWithIndex` throws when the collection is empty, which is
  // exactly the first-use case, so check the count before asking.
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
      [core.properties.name]: meta.name,
      [core.properties.localId]: localId,
      [core.properties.description]: meta.description,
    },
  });

  await folder.save();

  return folder.subject;
}
