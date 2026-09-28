import { styled } from 'styled-components';
import {
  core,
  dataBrowser,
  notifications,
  useStore,
  type Resource,
} from '@tomic/react';
import { useInbox } from '../../hooks/useInbox';
import {
  isUnread,
  markRead,
  occurredAt,
} from '../../helpers/notifications/inbox';
import { formatTimeAgo } from '../../helpers/formatTimeAgo';
import { constructOpenURL } from '../../helpers/navigation';
import { useNavigateWithTransition } from '../../hooks/useNavigateWithTransition';
import { useRightPanel } from '../RightPanel/RightPanelContext';
import { AgentAvatar } from '../Presence/AgentAvatar';
import { Button } from '../Button';
import { Row } from '../Row';

/**
 * Everything in your Inbox, newest first: who said what where. Unread items
 * carry a dot; opening one reads it and takes you to the conversation.
 */
export function NotificationList(): React.JSX.Element {
  const store = useStore();
  const { items, unread, ready } = useInbox();
  const navigate = useNavigateWithTransition();
  const { setPanelOpen } = useRightPanel();

  const open = (n: Resource) => {
    void markRead(store, [n.subject]);
    const about = n.get(dataBrowser.properties.about) as string | undefined;
    if (!about) return;
    navigate(constructOpenURL(about));

    if (n.get(notifications.properties.notificationKind) === 'comment') {
      setPanelOpen('comments', true);
    }
  };

  const markAllRead = () =>
    void markRead(
      store,
      items.filter(isUnread).map(n => n.subject),
    );

  return (
    <Column>
      <Row center justify='space-between' wrapItems>
        <h1>Notifications</h1>
        {unread > 0 && (
          <Button subtle onClick={markAllRead}>
            Mark all as read
          </Button>
        )}
      </Row>
      {ready && items.length === 0 && (
        <Empty>
          Nothing yet. New messages in your chats, comments on your things and
          replies to you show up here.
        </Empty>
      )}
      <List aria-label='Notifications'>
        {items.map(n => (
          <li key={n.subject}>
            <Item
              type='button'
              onClick={() => open(n)}
              data-unread={isUnread(n) || undefined}
            >
              <AgentAvatar
                agentSubject={
                  (n.get(notifications.properties.actor) as string) ?? ''
                }
                size='2rem'
              />
              <Text>
                <Title>{n.get(core.properties.name) as string}</Title>
                <Body>{n.get(core.properties.description) as string}</Body>
              </Text>
              <When>{formatTimeAgo(new Date(occurredAt(n)))}</When>
              {isUnread(n) && <Dot aria-label='Unread' />}
            </Item>
          </li>
        ))}
      </List>
    </Column>
  );
}

const Column = styled.div`
  display: flex;
  flex-direction: column;
  gap: ${p => p.theme.size(3)};
`;

const Empty = styled.p`
  color: ${p => p.theme.colors.textLight};
`;

const List = styled.ul`
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;

  & > li {
    list-style: none;
    margin: 0;
  }
`;

const Item = styled.button`
  display: flex;
  align-items: center;
  gap: 0.75rem;
  width: 100%;
  padding: 0.6rem 0.75rem;
  border: none;
  border-radius: ${p => p.theme.radius};
  background: transparent;
  color: ${p => p.theme.colors.text};
  text-align: left;
  cursor: pointer;

  &[data-unread] {
    background: ${p => p.theme.colors.bg1};
  }

  &:hover,
  &:focus-visible {
    background: ${p => p.theme.colors.bg2};
  }
`;

const Text = styled.span`
  display: flex;
  flex-direction: column;
  flex: 1;
  min-width: 0;
`;

const Title = styled.span`
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;

  button:not([data-unread]) & {
    font-weight: 400;
  }
`;

const Body = styled.span`
  color: ${p => p.theme.colors.textLight};
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
`;

const When = styled.span`
  flex-shrink: 0;
  font-size: 0.8rem;
  color: ${p => p.theme.colors.textLight};
`;

const Dot = styled.span`
  flex-shrink: 0;
  width: 0.5rem;
  height: 0.5rem;
  border-radius: 50%;
  background: ${p => p.theme.colors.main};
`;
