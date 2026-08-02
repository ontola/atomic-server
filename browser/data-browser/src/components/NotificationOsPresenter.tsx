import { useEffect, useRef } from 'react';
import toast from 'react-hot-toast';
import { styled } from 'styled-components';
import { FaBell } from 'react-icons/fa6';
import {
  dataBrowser,
  notifications,
  StoreEvents,
  useStore,
  type NotificationType,
} from '@tomic/react';
import { useNavigateWithTransition } from '../hooks/useNavigateWithTransition';
import { useNotificationEngine } from '../hooks/useNotificationEngine';
import { constructOpenURL } from '../helpers/navigation';
import { pathNames } from '../routes/paths';
import {
  cancelOsNotification,
  ensureOsNotificationPermission,
  getOsNotificationPermission,
  shouldUseOsSurface,
  showOsNotification,
} from '../helpers/osNotifications';
import { isRunningInTauri } from '../helpers/tauri';
import { onPushWakeReceive, onPushWakeTap } from '../helpers/pushWakeTap';
import { processPushWake } from '../helpers/processPushWake';
import { useDevicePushRegistration } from '../hooks/useDevicePushRegistration';

type CreatedItem = {
  subject: string;
  summary: string;
  about: string;
  type: NotificationType | string;
};

/**
 * Presents new notification items:
 * - Focused tab/window → in-app toast
 * - Hidden / unfocused → local OS notification (Web Notification API or Tauri)
 *
 * Never requests permission on mount. Watch enable / Settings / first OS
 * attempt (when permission is still `default`) may prompt.
 */
export function NotificationOsPresenter(): null {
  const store = useStore();
  const engine = useNotificationEngine();
  const navigate = useNavigateWithTransition();
  const seenRef = useRef(new Set<string>());
  /** Until true, mark subjects seen without presenting (backlog / boot). */
  const liveRef = useRef(false);

  // Phase 5: upsert DevicePushToken when a token exists (stub in Tauri DEV).
  useDevicePushRegistration();

  useEffect(() => {
    if (!engine) {
      return;
    }

    const openAbout = (about?: string) => {
      if (about) {
        navigate(constructOpenURL(about));
      } else {
        navigate(pathNames.notifications);
      }
    };

    // Cold-start / background push tap → navigate once React listeners arm.
    const unsubTap = onPushWakeTap(about => {
      openAbout(about);
    });

    // Data / silent wake → sync + materialize; surface only if still unread.
    const unsubReceive = onPushWakeReceive(wake => {
      void (async () => {
        const result = await processPushWake({
          store,
          engine,
          about: wake.about,
          type: wake.type,
        });

        if (result.action === 'suppress') {
          return;
        }

        liveRef.current = true;
        await present(
          {
            subject: result.itemSubject ?? `wake:${result.about}`,
            summary: result.summary ?? 'New notification',
            about: result.about,
            type: result.type,
          },
          openAbout,
        );
      })();
    });

    const handleCreated = (item: CreatedItem) => {
      if (seenRef.current.has(item.subject)) {
        return;
      }

      seenRef.current.add(item.subject);

      if (!liveRef.current) {
        return;
      }

      void present(item, openAbout);
    };

    engine.setOnItemCreated(handleCreated);

    const unsubStore = store.on(StoreEvents.ResourceUpdated, resource => {
      if (
        !resource.getClasses().includes(notifications.classes.notificationItem)
      ) {
        return;
      }

      const subject = resource.subject;
      const dismissed =
        resource.get(notifications.properties.dismissed) === true;
      const read =
        resource.get(notifications.properties.notificationRead) === true;

      if (dismissed || read) {
        void cancelOsNotification(subject);
        seenRef.current.add(subject);

        return;
      }

      // Items created outside the engine (manual / e2e seed) after go-live.
      if (seenRef.current.has(subject) || !liveRef.current) {
        if (!liveRef.current) {
          seenRef.current.add(subject);
        }

        return;
      }

      const summary =
        (resource.get(notifications.properties.notificationSummary) as
          | string
          | undefined) ??
        (resource.get('https://atomicdata.dev/properties/name') as
          | string
          | undefined) ??
        'New notification';
      const about =
        (resource.get(dataBrowser.properties.about) as string | undefined) ??
        '';
      const type =
        (resource.get(notifications.properties.notificationType) as
          | string
          | undefined) ?? 'mention';

      handleCreated({ subject, summary, about, type });
    });

    // Swallow backlog / reconcile without OS spam, then go live.
    const timer = setTimeout(() => {
      liveRef.current = true;
    }, 2500);

    return () => {
      clearTimeout(timer);
      liveRef.current = false;
      unsubTap();
      unsubReceive();
      unsubStore();
      engine.setOnItemCreated(undefined);
    };
  }, [engine, store, navigate]);

  useEffect(() => {
    if (!isRunningInTauri()) {
      return;
    }

    let cancelled = false;
    let unsubscribe: (() => void) | undefined;

    void (async () => {
      try {
        const { onAction } = await import('@tauri-apps/plugin-notification');
        const listener = await onAction(notification => {
          const extra = notification.extra as
            | { about?: string }
            | undefined;
          const about =
            typeof extra?.about === 'string' && extra.about.length > 0
              ? extra.about
              : undefined;

          if (about) {
            navigate(constructOpenURL(about));
          } else {
            navigate(pathNames.notifications);
          }
        });

        if (cancelled) {
          await listener.unregister();

          return;
        }

        unsubscribe = () => {
          void listener.unregister();
        };
      } catch {
        // Plugin not available in this build.
      }
    })();

    return () => {
      cancelled = true;
      unsubscribe?.();
    };
  }, [navigate]);

  return null;
}

async function present(
  item: CreatedItem,
  openAbout: (about?: string) => void,
): Promise<void> {
  if (shouldUseOsSurface()) {
    let permission = await getOsNotificationPermission();

    if (permission === 'default') {
      const ok = await ensureOsNotificationPermission();
      permission = ok ? 'granted' : await getOsNotificationPermission();
    }

    if (permission === 'granted') {
      await showOsNotification(
        {
          subject: item.subject,
          title: 'Atomic',
          body: item.summary,
          about: item.about || undefined,
        },
        { onClick: openAbout },
      );

      return;
    }
  }

  toast.custom(
    t => (
      <ToastCard
        type='button'
        onClick={() => {
          openAbout(item.about || undefined);
          toast.dismiss(t.id);
        }}
        title='Open notification'
      >
        <FaBell />
        <ToastBody>
          <ToastTitle>{item.summary}</ToastTitle>
          <ToastMeta>{item.type}</ToastMeta>
        </ToastBody>
      </ToastCard>
    ),
    { duration: 5000, id: item.subject },
  );
}

const ToastCard = styled.button`
  display: flex;
  align-items: center;
  gap: 0.6rem;
  max-width: 22rem;
  padding: 0.6rem 0.8rem;
  border: 1px solid ${p => p.theme.colors.bg2};
  border-radius: ${p => p.theme.radius};
  background: ${p => p.theme.colors.bg};
  box-shadow: ${p => p.theme.boxShadowSoft};
  cursor: pointer;
  text-align: left;
  color: ${p => p.theme.colors.text};

  svg {
    flex-shrink: 0;
    opacity: 0.7;
  }
`;

const ToastBody = styled.span`
  display: flex;
  flex-direction: column;
  min-width: 0;
`;

const ToastTitle = styled.span`
  font-weight: 600;
  font-size: 0.85rem;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
`;

const ToastMeta = styled.span`
  font-size: 0.75rem;
  color: ${p => p.theme.colors.textLight};
`;
