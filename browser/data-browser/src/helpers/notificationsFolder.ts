import type { Store } from '@tomic/react';
import { getOrCreateFolderByLocalId } from './folderByLocalId';

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
  return getOrCreateFolderByLocalId(store, drive, NOTIFICATIONS_LOCAL_ID, {
    name: 'Notifications',
    description:
      'Your notification inbox. Items sync across your devices, including read state.',
  });
}
