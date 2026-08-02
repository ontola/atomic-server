/**
 * Process an incoming remote push wake: sync/materialize then decide whether
 * to show a local banner. Transport plugins should call
 * {@link queuePushWakeReceive} once the payload arrives.
 */

import {
  CollectionBuilder,
  dataBrowser,
  handlePushWake,
  notifications,
  type NotificationEngine,
  type Store,
} from '@tomic/lib';

export type ProcessPushWakeResult =
  | { action: 'suppress'; reason: 'read' | 'dismissed' }
  | {
      action: 'surface';
      about: string;
      type: string;
      itemSubject?: string;
      summary?: string;
    };

/**
 * Fetch `about`, run mention backlog reconcile, suppress if the personal
 * NotificationItem is already read/dismissed.
 */
export async function processPushWake(opts: {
  store: Store;
  engine: NotificationEngine;
  about: string;
  type: string;
}): Promise<ProcessPushWakeResult> {
  const { store, engine, about, type } = opts;

  return handlePushWake({
    store,
    about,
    type,
    reconcile: () => engine.reconcileMentionBacklog(),
    findItemForAbout: aboutSubject =>
      findNotificationItemForAbout(store, engine, aboutSubject),
  });
}

async function findNotificationItemForAbout(
  store: Store,
  engine: NotificationEngine,
  about: string,
): Promise<
  | {
      subject: string;
      read: boolean;
      dismissed: boolean;
      summary?: string;
    }
  | undefined
> {
  try {
    const collection = await new CollectionBuilder(store)
      .setDrive(engine.getPersonalDrive())
      .setProperty(dataBrowser.properties.about)
      .setValue(about)
      .setPageSize(20)
      .buildAndFetch();

    for (let i = 0; i < collection.totalMembers; i++) {
      const subject = await collection.getMemberWithIndex(i);

      if (!subject) {
        continue;
      }

      const res = await store.getResource(subject);

      if (
        !res.getClasses().includes(notifications.classes.notificationItem)
      ) {
        continue;
      }

      return {
        subject,
        read: res.get(notifications.properties.notificationRead) === true,
        dismissed: res.get(notifications.properties.dismissed) === true,
        summary: res.get(notifications.properties.notificationSummary) as
          | string
          | undefined,
      };
    }
  } catch {
    // Index unavailable — treat as no item.
  }

  return undefined;
}
