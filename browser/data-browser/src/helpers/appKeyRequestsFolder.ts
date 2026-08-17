import { CollectionBuilder, core, dataBrowser, type Store } from '@tomic/react';

/** Well-known id of the personal-drive pending app-key requests folder. */
export const APP_KEY_REQUESTS_LOCAL_ID = 'app-key-requests';

/**
 * Inbox for OAuth-shaped app key requests. Created on first use.
 *
 * The folder has no public read — only people who can write the personal
 * drive see pending consents. Each child is a request (name, read/write,
 * targets). Approving mints or binds a key and deletes the row.
 */
export async function getOrCreateAppKeyRequestsFolder(
  store: Store,
  drive: string,
): Promise<string> {
  const collection = await new CollectionBuilder(store)
    .setDrive(drive)
    .setProperty(core.properties.localId)
    .setValue(APP_KEY_REQUESTS_LOCAL_ID)
    .setPageSize(1)
    .buildAndFetch();

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
      [core.properties.name]: 'App key requests',
      [core.properties.localId]: APP_KEY_REQUESTS_LOCAL_ID,
      [core.properties.description]:
        'Pending rights requests from apps. Approve one to mint or bind an app key. The secret is never stored here.',
    },
  });

  await folder.save();
  await store.notifyResourceManuallyCreated(folder);

  return folder.subject;
}
