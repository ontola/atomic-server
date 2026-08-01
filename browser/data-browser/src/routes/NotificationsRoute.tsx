import { useCallback, useEffect, useState } from 'react';
import { createRoute } from '@tanstack/react-router';
import { useNavigateWithTransition } from '../hooks/useNavigateWithTransition';
import { styled } from 'styled-components';
import {
  CollectionBuilder,
  core,
  dataBrowser,
  notifications,
  useResource,
  useStore,
  useString,
  useTitle,
} from '@tomic/react';
import { FaBell, FaCheck, FaTrash } from 'react-icons/fa6';
import { ContainerNarrow } from '../components/Containers';
import { Main } from '../components/Main';
import { Button } from '../components/Button';
import { Column, Row } from '../components/Row';
import { ResourceInline } from '../views/ResourceInline';
import { useSettings } from '../helpers/AppSettings';
import { fetchPersonalDriveSubject } from '../helpers/personalDrive';
import {
  useNotificationEngine,
  useUnreadNotificationCount,
} from '../hooks/useNotificationEngine';
import { constructOpenURL } from '../helpers/navigation';
import { pathNames } from './paths';
import { appRoute } from './RootRoutes';
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
  const [subjects, setSubjects] = useState<string[]>([]);
  const [personalDrive, setPersonalDrive] = useState<string>();
  const [tick, setTick] = useState(0);

  useEffect(() => {
    if (!agent) {
      setPersonalDrive(undefined);

      return;
    }

    let cancelled = false;

    void fetchPersonalDriveSubject(store, agent).then(drive => {
      if (!cancelled) {
        setPersonalDrive(drive);
      }
    });

    return () => {
      cancelled = true;
    };
  }, [store, agent]);

  const refresh = useCallback(async () => {
    if (!personalDrive) {
      setSubjects([]);

      return;
    }

    try {
      const collection = await new CollectionBuilder(store)
        .setDrive(personalDrive)
        .setProperty(core.properties.isA)
        .setValue(notifications.classes.notificationItem)
        .setPageSize(100)
        .buildAndFetch();

      const next: string[] = [];

      for (let i = 0; i < collection.totalMembers; i++) {
        const subject = await collection.getMemberWithIndex(i);

        if (!subject) {
          continue;
        }

        const res = store.getResourceLoading(subject);

        if (res.get(notifications.properties.dismissed) === true) {
          continue;
        }

        next.push(subject);
      }

      setSubjects(next);
    } catch {
      setSubjects([]);
    }
  }, [store, personalDrive]);

  useEffect(() => {
    void refresh();
  }, [refresh, tick]);

  useEffect(() => {
    return engine?.subscribe(() => setTick(t => t + 1));
  }, [engine]);

  const markAllRead = async () => {
    if (!engine) {
      return;
    }

    await engine.markAllRead(subjects);
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
          {unread > 0 && (
            <Button subtle onClick={() => void markAllRead()}>
              <FaCheck /> Mark all read
            </Button>
          )}
        </Row>
        {subjects.length === 0 ? (
          <Empty>
            <FaBell />
            <p>No notifications yet.</p>
            <Hint>
              You&apos;ll be notified when someone mentions you, or when a table
              or collection you watch updates.
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
  const engine = useNotificationEngine();
  const navigate = useNavigateWithTransition();
  const [summary] = useString(
    resource,
    notifications.properties.notificationSummary,
  );
  const [type] = useString(resource, notifications.properties.notificationType);
  const [about] = useString(resource, dataBrowser.properties.about);
  const [title] = useTitle(resource);
  const read = resource.get(notifications.properties.notificationRead) === true;

  const open = async () => {
    if (engine && !read) {
      await engine.markRead(subject);
      onChanged();
    }

    if (about) {
      navigate(constructOpenURL(about));
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
                  <span onClick={e => e.stopPropagation()}>
                    <ResourceInline subject={about} />
                  </span>
                </>
              )}
            </Meta>
          </Column>
        </Row>
      </ItemBody>
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
