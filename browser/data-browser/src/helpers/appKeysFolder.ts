import { CollectionBuilder, core, dataBrowser, type Store } from '@tomic/react';

/** Well-known id of the personal-drive App keys folder, resolved via `localId`. */
export const APP_KEYS_LOCAL_ID = 'app-keys';

/**
 * The personal drive's App keys folder, created on first use.
 *
 * Issued agents (plugin / integration secrets) live here so the list syncs
 * with the personal drive. The folder has no public read grant — only people
 * who can write the personal drive can see which keys exist. Each child is a
 * public Agent resource; the secret is never stored.
 *
 * Found by `localId`, same pattern as Drafts and Forks.
 */
export async function getOrCreateAppKeysFolder(
  store: Store,
  drive: string,
): Promise<string> {
  const collection = await new CollectionBuilder(store)
    .setDrive(drive)
    .setProperty(core.properties.localId)
    .setValue(APP_KEYS_LOCAL_ID)
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
      [core.properties.name]: 'App keys',
      [core.properties.localId]: APP_KEYS_LOCAL_ID,
      [core.properties.description]:
        'Secrets for apps and plugins. Each child is its own identity — not your account. The secret is shown once at creation and is not stored here.',
    },
  });

  await folder.save();
  await store.notifyResourceManuallyCreated(folder);

  return folder.subject;
}
