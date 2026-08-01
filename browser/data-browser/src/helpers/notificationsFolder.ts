import { CollectionBuilder, core, dataBrowser, type Store } from '@tomic/react';

/** Well-known id of the per-personal-drive Notifications folder. */
const NOTIFICATIONS_LOCAL_ID = 'notifications';

/**
 * The personal drive's Notifications folder, created on first use.
 *
 * Holds `NotificationItem`s (synced read/dismissed state) and optionally
 * `WatchSubscription` / `NotificationPreferences` resources. See
 * `planning/notifications.md`.
 */
export async function getOrCreateNotificationsFolder(
  store: Store,
  drive: string,
): Promise<string> {
  const collection = await new CollectionBuilder(store)
    .setDrive(drive)
    .setProperty(core.properties.localId)
    .setValue(NOTIFICATIONS_LOCAL_ID)
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
      [core.properties.name]: 'Notifications',
      [core.properties.localId]: NOTIFICATIONS_LOCAL_ID,
      [core.properties.description]:
        'Your notification inbox. Items sync across your devices, including read state.',
    },
  });

  await folder.save();

  return folder.subject;
}
