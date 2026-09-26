import {
  core,
  notifications,
  useCollection,
  useCollectionPage,
  useResources,
  type Resource,
} from '@tomic/react';
import { usePrivateDrive } from './usePrivateDrive';
import { dedupeBySource, isUnread } from '../helpers/notifications/inbox';

const PAGE_SIZE = 100;

/**
 * The signed-in person's notifications, newest first, one per source, live.
 * Found by class in the private drive rather than by walking the Inbox, so
 * copies made by another device count as soon as they sync.
 */
export function useInbox(): {
  items: Resource[];
  unread: number;
  ready: boolean;
  privateDrive: string | undefined;
} {
  const { privateDrive } = usePrivateDrive();
  const { collection, ready } = useCollection(
    {
      property: core.properties.isA,
      value: notifications.classes.notification,
      drive: privateDrive,
      sort_by: notifications.properties.occurredAt,
      sort_desc: true,
    },
    { pageSize: PAGE_SIZE },
  );
  const members = useCollectionPage(collection, 0);
  const resources = useResources(privateDrive ? members : []);

  const loaded = [...resources.values()].filter(
    r =>
      !r.loading &&
      !r.error &&
      r.hasClasses(notifications.classes.notification),
  );
  const items = dedupeBySource(loaded);

  return {
    items,
    unread: items.filter(isUnread).length,
    ready: ready && !!privateDrive,
    privateDrive,
  };
}
