import {
  createContext,
  createElement,
  useCallback,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from 'react';
import {
  CollectionBuilder,
  NotificationEngine,
  StoreEvents,
  core,
  notifications,
  useStore,
  visibleNotificationItems,
} from '@tomic/react';
import { useSettings } from '../helpers/AppSettings';
import { fetchPersonalDriveSubject } from '../helpers/personalDrive';
import { getOrCreateNotificationsFolder } from '../helpers/notificationsFolder';

const NotificationEngineContext = createContext<NotificationEngine | null>(
  null,
);

/**
 * Starts a {@link NotificationEngine} for the current agent + personal drive.
 * Remounts when the agent changes.
 */
export function NotificationEngineProvider({
  children,
}: {
  children: ReactNode;
}): React.JSX.Element {
  const store = useStore();
  const { agent } = useSettings();
  const [engine, setEngine] = useState<NotificationEngine | null>(null);

  useEffect(() => {
    let cancelled = false;
    let active: NotificationEngine | null = null;

    async function start() {
      if (!agent?.subject) {
        setEngine(null);

        return;
      }

      const personalDrive = await fetchPersonalDriveSubject(store, agent);

      if (!personalDrive || cancelled) {
        setEngine(null);

        return;
      }

      active = new NotificationEngine({
        store,
        agentSubject: agent.subject,
        personalDrive,
        getNotificationsFolder: getOrCreateNotificationsFolder,
      });
      await active.start();

      if (cancelled) {
        active.stop();

        return;
      }

      // E2E / console: flushPendingWatches(), inspect watches.
      (
        window as Window & { __notificationEngine?: NotificationEngine }
      ).__notificationEngine = active;

      setEngine(active);
    }

    void start();

    return () => {
      cancelled = true;
      active?.stop();

      const w = window as Window & { __notificationEngine?: NotificationEngine };

      if (w.__notificationEngine === active) {
        delete w.__notificationEngine;
      }

      setEngine(null);
    };
  }, [store, agent]);

  return createElement(
    NotificationEngineContext.Provider,
    { value: engine },
    children,
  );
}

export function useNotificationEngine(): NotificationEngine | null {
  return useContext(NotificationEngineContext);
}

/**
 * Unread (and not dismissed) notification count for the sidebar badge.
 */
export function useUnreadNotificationCount(): number {
  const store = useStore();
  const engine = useNotificationEngine();
  const { agent } = useSettings();
  const [unread, setUnread] = useState(0);

  const refresh = useCallback(async () => {
    if (!agent?.subject) {
      setUnread(0);

      return;
    }

    const seen = new Set<string>();
    let n = 0;

    const consider = (subject: string) => {
      if (seen.has(subject)) {
        return;
      }

      seen.add(subject);
      const res = store.getResourceLoading(subject);

      if (res.get(notifications.properties.dismissed) === true) {
        return;
      }

      if (res.get(notifications.properties.notificationRead) !== true) {
        n += 1;
      }
    };

    for (const res of visibleNotificationItems(store)) {
      consider(res.subject);
    }

    const personalDrive = await fetchPersonalDriveSubject(store, agent);

    if (personalDrive) {
      try {
        const collection = await new CollectionBuilder(store)
          .setDrive(personalDrive)
          .setProperty(core.properties.isA)
          .setValue(notifications.classes.notificationItem)
          .setPageSize(100)
          .buildAndFetch();

        for (let i = 0; i < collection.totalMembers; i++) {
          const subject = await collection.getMemberWithIndex(i);

          if (subject) {
            consider(subject);
          }
        }
      } catch {
        // Keep the in-memory count if the index query is still empty.
      }
    }

    setUnread(n);
  }, [store, agent]);

  useEffect(() => {
    void refresh();

    let timer: ReturnType<typeof setTimeout> | undefined;

    const schedule = () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        void refresh();
      }, 300);
    };

    const unsubEngine = engine?.subscribe(schedule);
    const unsubStore = store.on(StoreEvents.ResourceUpdated, resource => {
      if (
        resource.getClasses().includes(notifications.classes.notificationItem)
      ) {
        schedule();
      }
    });
    const unsubCreated = store.on(
      StoreEvents.ResourceManuallyCreated,
      resource => {
        if (
          resource.getClasses().includes(notifications.classes.notificationItem)
        ) {
          schedule();
        }
      },
    );
    const unsubSync = store.on(StoreEvents.SyncStatusChanged, schedule);

    return () => {
      clearTimeout(timer);
      unsubEngine?.();
      unsubStore();
      unsubCreated();
      unsubSync();
    };
  }, [store, engine, refresh]);

  return unread;
}
