import { styled } from 'styled-components';
import { FaBell } from 'react-icons/fa6';
import { SideBarMenuItem } from './SideBarMenuItem';
import { paths } from '../../routes/paths';
import { useInbox } from '../../hooks/useInbox';

/** Opens the Notifications page; shows how many are unread. */
export function NotificationsMenuItem({
  onClick,
}: {
  onClick: () => void;
}): React.JSX.Element {
  const { unread } = useInbox();
  const label = unread > 0 ? `Notifications, ${unread} unread` : undefined;

  return (
    <SideBarMenuItem
      icon={<FaBell />}
      label='Notifications'
      helper={label ?? 'Messages, comments and replies for you'}
      path={paths.notifications}
      onClick={onClick}
      suffix={
        unread > 0 && (
          <Count aria-label={label}>{unread > 99 ? '99+' : unread}</Count>
        )
      }
    />
  );
}

const Count = styled.span`
  flex-shrink: 0;
  min-width: 1.2rem;
  padding: 0 0.35rem;
  border-radius: 999px;
  background: ${p => p.theme.colors.main};
  color: white;
  font-size: 0.7rem;
  font-weight: 600;
  line-height: 1.2rem;
  text-align: center;
`;
