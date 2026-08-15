import { useCallback, useEffect, useState } from 'react';
import {
  CollectionBuilder,
  core,
  notifications,
  useStore,
  useTitle,
  type Resource,
} from '@tomic/react';
import { FaBell, FaBellSlash } from 'react-icons/fa6';
import { Button } from './Button';
import { useSettings } from '../helpers/AppSettings';
import { fetchPrivateDriveSubject } from '../helpers/privateDrive';
import { getOrCreateNotificationsFolder } from '../helpers/notificationsFolder';
import { useNotificationEngine } from '../hooks/useNotificationEngine';
import { ensureOsNotificationPermission } from '../helpers/osNotifications';

interface WatchToggleProps {
  resource: Resource;
}

/**
 * Toggle a {@link notifications.classes.watchSubscription} for a Table /
 * Collection. Creates the preference on the personal drive.
 */
export function WatchToggle({
  resource,
}: WatchToggleProps): React.JSX.Element | null {
  const store = useStore();
  const { agent } = useSettings();
  const engine = useNotificationEngine();
  const [title] = useTitle(resource);
  const [watchSubject, setWatchSubject] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    if (!agent?.subject) {
      setWatchSubject(undefined);

      return;
    }

    const personalDrive = await fetchPrivateDriveSubject(store, agent);

    if (!personalDrive) {
      setWatchSubject(undefined);

      return;
    }

    try {
      const collection = await new CollectionBuilder(store)
        .setDrive(personalDrive)
        .setProperty(notifications.properties.watchTarget)
        .setValue(resource.subject)
        .setPageSize(5)
        .buildAndFetch();

      for (let i = 0; i < collection.totalMembers; i++) {
        const subject = await collection.getMemberWithIndex(i);

        if (!subject) {
          continue;
        }

        const res = store.getResourceLoading(subject);

        if (
          res.getClasses().includes(notifications.classes.watchSubscription)
        ) {
          setWatchSubject(subject);

          return;
        }
      }

      setWatchSubject(undefined);
    } catch {
      setWatchSubject(undefined);
    }
  }, [store, agent, resource.subject]);

  useEffect(() => {
    void refresh();

    return engine?.subscribe(() => {
      void refresh();
    });
  }, [engine, refresh]);

  if (!agent) {
    return null;
  }

  const watching = !!watchSubject;

  const toggle = async () => {
    if (busy || !agent.subject) {
      return;
    }

    setBusy(true);

    try {
      const personalDrive = await fetchPrivateDriveSubject(store, agent);

      if (!personalDrive) {
        setBusy(false);

        return;
      }

      if (watchSubject) {
        const existing = await store.getResource(watchSubject);
        await existing.destroy();
        setWatchSubject(undefined);
        await engine?.reloadWatches();
        setBusy(false);

        return;
      }

      const folder = await getOrCreateNotificationsFolder(store, personalDrive);
      // First watch enable is a natural moment to ask for OS banners
      // (never on cold start — see planning/notifications.md Phase 4).
      void ensureOsNotificationPermission();
      const watch = await store.newResource({
        parent: folder,
        isA: [notifications.classes.watchSubscription],
        propVals: {
          [core.properties.name]: `Watch ${title || 'table'}`,
          [notifications.properties.watchTarget]: resource.subject,
          [notifications.properties.watchKind]: 'membership',
          [notifications.properties.notificationEnabled]: true,
          [notifications.properties.notificationChannels]: ['inApp', 'os'],
        },
      });
      await watch.save();
      setWatchSubject(watch.subject);
      await engine?.reloadWatches();
    } catch {
      // Keep previous UI state on failure.
    }

    setBusy(false);
  };

  return (
    <Button
      subtle
      disabled={busy}
      onClick={() => void toggle()}
      title={
        watching
          ? 'Stop notifying me when this changes'
          : 'Notify me when rows change'
      }
      data-testid='watch-toggle'
      data-watching={watching ? 'true' : 'false'}
    >
      {watching ? <FaBell /> : <FaBellSlash />}
      {watching ? 'Watching' : 'Watch'}
    </Button>
  );
}
