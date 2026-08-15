import { useCallback, useEffect, useState } from 'react';
import { createRoute } from '@tanstack/react-router';
import { useNavigateWithTransition } from '../hooks/useNavigateWithTransition';
import { styled } from 'styled-components';
import {
  CollectionBuilder,
  StoreEvents,
  core,
  dataBrowser,
  fetchNotificationItemSubjectsFromServer,
  grantAccessRequest,
  notifications,
  useResource,
  useStore,
  useString,
  useTitle,
  useValue,
  visibleNotificationItems,
} from '@tomic/react';
import { FaBell, FaCheck, FaTrash, FaUnlockKeyhole } from 'react-icons/fa6';
import { ContainerNarrow } from '../components/Containers';
import { Main } from '../components/Main';
import { Button } from '../components/Button';
import { Column, Row } from '../components/Row';
import { ResourceInline } from '../views/ResourceInline';
import { useSettings } from '../helpers/AppSettings';
import {
  useNotificationEngine,
  useUnreadNotificationCount,
} from '../hooks/useNotificationEngine';
import { usePrivateDrive } from '../hooks/usePrivateDrive';
import { constructOpenURL } from '../helpers/navigation';
import { pathNames } from './paths';
import { appRoute } from './RootRoutes';
import { SendMessageButton } from '../components/SendMessageDialog';
import toast from 'react-hot-toast';

export const NotificationsRoute = createRoute({
  path: pathNames.notifications,
  component: () => <NotificationsPage />,
  getParentRoute: () => appRoute,
});

function NotificationsPage(): React.JSX.Element {
  const store = useStore();
  const { agent } = useSettings();
  const engine = useNotificationEngine();
  const unread = useUnreadNotificationCount();
  const { privateDrive: personalDrive } = usePrivateDrive();
  const [subjects, setSubjects] = useState<string[]>([]);
  const [tick, setTick] = useState(0);

  const refresh = useCallback(async () => {
    const seen = new Set<string>();
    const next: string[] = [];

    const consider = (subject: string) => {
      if (seen.has(subject)) {
        return;
      }

      seen.add(subject);
      const res = store.getResourceLoading(subject);

      if (res.get(notifications.properties.dismissed) === true) {
        return;
      }

      next.push(subject);
    };

    for (const res of visibleNotificationItems(store)) {
      consider(res.subject);
    }

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
        // In-memory items still render if the index query races drive sync.
      }

      try {
        const fromServer = await fetchNotificationItemSubjectsFromServer(
          store,
          personalDrive,
        );

        for (const subject of fromServer) {
          consider(subject);
        }
      } catch {
        // Offline / query 404 — keep whatever we already listed.
      }
    }

    setSubjects(next);
  }, [store, personalDrive]);

  useEffect(() => {
    void refresh();
  }, [refresh, tick]);

  useEffect(() => {
    return engine?.subscribe(() => setTick(t => t + 1));
  }, [engine]);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;

    const bump = () => {
      clearTimeout(timer);
      timer = setTimeout(() => setTick(t => t + 1), 300);
    };

    const unsubUpdated = store.on(StoreEvents.ResourceUpdated, bump);
    const unsubCreated = store.on(StoreEvents.ResourceManuallyCreated, bump);
    const unsubSync = store.on(StoreEvents.SyncStatusChanged, bump);

    return () => {
      clearTimeout(timer);
      unsubUpdated();
      unsubCreated();
      unsubSync();
    };
  }, [store]);

  const markAllRead = async () => {
    if (engine) {
      await engine.markAllRead(subjects);
      setTick(t => t + 1);

      return;
    }

    // Engine still starting — mark via the store so the button is never a no-op.
    for (const subject of subjects) {
      const res = await store.getResource(subject);

      if (res.get(notifications.properties.notificationRead) === true) {
        continue;
      }

      await res.set(notifications.properties.notificationRead, true);
      await res.save();
      store.notifyResourceUpdated(res);
    }

    setTick(t => t + 1);
  };

  if (!agent) {
    return (
      <Main>
        <ContainerNarrow>
          <h1>Notifications</h1>
          <p>Sign in to see your notifications.</p>
        </ContainerNarrow>
      </Main>
    );
  }

  return (
    <Main>
      <ContainerNarrow>
        <Row justify='space-between' center>
          <h1>Notifications</h1>
          <Row gap='0.5rem' center>
            <SendMessageButton />
            {unread > 0 && (
              <Button
                subtle
                data-testid='mark-all-read'
                onClick={() => void markAllRead()}
              >
                <FaCheck /> Mark all read
              </Button>
            )}
          </Row>
        </Row>
        {subjects.length === 0 ? (
          <Empty data-testid='notifications-empty'>
            <FaBell />
            <p>No notifications yet.</p>
            <Hint>
              You&apos;ll be notified when someone mentions you, sends you a
              message, requests access, or when a table or collection you watch
              updates.
            </Hint>
          </Empty>
        ) : (
          <Column gap='0.5rem'>
            {subjects.map(subject => (
              <NotificationRow
                key={subject}
                subject={subject}
                onChanged={() => setTick(t => t + 1)}
              />
            ))}
          </Column>
        )}
      </ContainerNarrow>
    </Main>
  );
}

function NotificationRow({
  subject,
  onChanged,
}: {
  subject: string;
  onChanged: () => void;
}) {
  const resource = useResource(subject);
  const store = useStore();
  const engine = useNotificationEngine();
  const navigate = useNavigateWithTransition();
  const [summary] = useString(
    resource,
    notifications.properties.notificationSummary,
  );
  const [type] = useString(resource, notifications.properties.notificationType);
  const [about] = useString(resource, dataBrowser.properties.about);
  const source = useResource(about ?? '');
  const [title] = useTitle(resource);
  // useValue (not resource.get during render) so LocalChange from markRead
  // re-renders — useResource alone only wakes on store.notify.
  const [readRaw] = useValue(
    resource,
    notifications.properties.notificationRead,
  );
  const read = readRaw === true;
  const [requestStatus] = useString(
    source,
    notifications.properties.accessRequestStatus,
  );
  const [targetSubject] = useString(source, dataBrowser.properties.about);
  const [busyGrant, setBusyGrant] = useState(false);

  const isAccessRequest = type === 'access-request';
  const alreadyGranted = requestStatus === 'granted';

  const open = async () => {
    if (engine && !read) {
      await engine.markRead(subject);
      onChanged();
    }

    const dest = isAccessRequest ? (targetSubject ?? about) : about;

    if (dest) {
      navigate(constructOpenURL(dest));
    }
  };

  const grant = async (e: React.MouseEvent) => {
    e.stopPropagation();

    if (busyGrant || !about) {
      return;
    }

    setBusyGrant(true);

    try {
      const accessRequest = await store.getResource(about);
      await grantAccessRequest(store, accessRequest);

      if (engine && !read) {
        await engine.markRead(subject);
      }

      toast.success('Access granted');
      onChanged();
      setBusyGrant(false);

      if (targetSubject) {
        navigate(constructOpenURL(targetSubject));
      }
    } catch (err) {
      toast.error((err as Error).message);
      setBusyGrant(false);
    }
  };

  const dismiss = async () => {
    if (!engine) {
      return;
    }

    await engine.dismiss(subject);
    onChanged();
  };

  return (
    <Item data-unread={read ? undefined : ''} data-testid='notification-item'>
      <ItemBody onClick={() => void open()}>
        <Row gap='0.5rem' center>
          {!read && <UnreadDot aria-hidden />}
          <Column gap='0.15rem'>
            <strong>{summary ?? title}</strong>
            <Meta>
              {type}
              {about && (
                <>
                  {' · '}
                  <span
                    role='presentation'
                    onClick={e => e.stopPropagation()}
                    onKeyDown={e => e.stopPropagation()}
                  >
                    <ResourceInline
                      subject={
                        isAccessRequest && targetSubject ? targetSubject : about
                      }
                    />
                  </span>
                </>
              )}
            </Meta>
          </Column>
        </Row>
      </ItemBody>
      {isAccessRequest && !alreadyGranted && (
        <Button
          subtle
          data-testid='grant-access'
          title='Grant access'
          disabled={busyGrant}
          onClick={e => void grant(e)}
        >
          <FaUnlockKeyhole />
          Grant
        </Button>
      )}
      <Button
        subtle
        title='Dismiss'
        onClick={e => {
          e.stopPropagation();
          void dismiss();
        }}
      >
        <FaTrash />
      </Button>
    </Item>
  );
}

const Empty = styled.div`
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 0.5rem;
  padding: 3rem 1rem;
  color: ${p => p.theme.colors.textLight};

  svg {
    font-size: 2rem;
    opacity: 0.5;
  }
`;

const Hint = styled.p`
  max-width: 28rem;
  text-align: center;
  margin: 0;
`;

const Item = styled.div`
  display: flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0.75rem 1rem;
  border-radius: ${p => p.theme.radius};
  background: ${p => p.theme.colors.bg1};

  &[data-unread] {
    background: ${p => p.theme.colors.bg};
    box-shadow: inset 0 0 0 1px ${p => p.theme.colors.main};
  }
`;

const ItemBody = styled.button`
  flex: 1;
  min-width: 0;
  text-align: start;
  background: none;
  border: none;
  padding: 0;
  cursor: pointer;
  color: inherit;
  font: inherit;
`;

const UnreadDot = styled.span`
  width: 0.5rem;
  height: 0.5rem;
  border-radius: 50%;
  background: ${p => p.theme.colors.main};
  flex-shrink: 0;
`;

const Meta = styled.span`
  font-size: 0.85rem;
  color: ${p => p.theme.colors.textLight};
`;
