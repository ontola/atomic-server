import { styled } from 'styled-components';
import { FaBell } from 'react-icons/fa6';
import { useCurrentAgent } from '@tomic/react';
import { useLocation } from '@tanstack/react-router';
import { LabelButton } from '../NavBarButton';
import { useInbox } from '../../hooks/useInbox';
import { paths } from '../../routes/paths';
import { useNavigateWithTransition } from '../../hooks/useNavigateWithTransition';

/**
 * The bell in the top bar: always in view, on a phone too, where the app
 * menu's entry sits behind the drawer. Shows how many are unread and opens
 * the Notifications page.
 */
export function NotificationsBell(): React.JSX.Element | null {
  const [agent] = useCurrentAgent();

  if (!agent) return null;

  return <Bell />;
}

function Bell(): React.JSX.Element {
  const { unread } = useInbox();
  const navigate = useNavigateWithTransition();
  const { pathname } = useLocation();
  const label =
    unread > 0 ? `Notifications, ${unread} unread` : 'Notifications';

  return (
    <LabelButton
      type='button'
      $active={pathname === paths.notifications}
      onClick={() => navigate(paths.notifications)}
      title={label}
      aria-label={label}
      data-testid='navbar-notifications'
    >
      <BellIcon>
        <FaBell />
        {unread > 0 && (
          <Count aria-hidden>{unread > 99 ? '99+' : unread}</Count>
        )}
      </BellIcon>
    </LabelButton>
  );
}

const BellIcon = styled.b`
  position: relative;
  display: inline-flex;
  font-weight: inherit;
`;

/* A <b>, not a <span>: the bar hides spans when it collapses to icons. */
const Count = styled.b`
  position: absolute;
  top: -0.4rem;
  right: -0.55rem;
  min-width: 1rem;
  padding: 0 0.25rem;
  border-radius: 999px;
  background: ${p => p.theme.colors.main};
  color: white;
  font-size: 0.65rem;
  font-weight: 600;
  line-height: 1rem;
  text-align: center;
`;
