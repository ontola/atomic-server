/**
 * Process an incoming remote push wake: sync/materialize then decide whether
 * to show a local banner. Transport plugins should call
 * {@link queuePushWakeReceive} once the payload arrives.
 */

import {
  findNotificationItemForAbout,
  handlePushWake,
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
      findNotificationItemForAbout(
        store,
        engine.getPersonalDrive(),
        aboutSubject,
      ),
  });
}
