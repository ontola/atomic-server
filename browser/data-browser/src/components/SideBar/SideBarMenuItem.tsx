import { styled } from 'styled-components';
import { AtomicLink, AtomicLinkProps } from '../AtomicLink';
import { SideBarItem } from './SideBarItem';
import { useLocation } from '@tanstack/react-router';

/** Full-width row; matches resource links in the tree (clean AtomicLink is inline by default). */
export const SideBarMenuItemLink = styled(AtomicLink)`
  display: block;
  width: 100%;
  min-width: 0;
  box-sizing: border-box;
`;

/** Full-width menu / shared-with-me row (hover fills sidebar). */
export const SideBarMenuRow = styled(SideBarItem)`
  width: 100%;
  min-width: 0;
`;

export const SideBarMenuRowLabel = styled.span`
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  text-align: start;
`;

export interface SideBarMenuItemProps extends AtomicLinkProps {
  label: string;
  helper?: string;
  icon?: React.ReactNode;
  disabled?: boolean;
  /** Optional count badge (e.g. unread notifications). */
  badge?: number;
  /** Is called when clicking on the item. Used for closing the menu. */
  onClick?: () => void;
}

export function SideBarMenuItem({
  helper,
  label,
  icon,
  badge,
  path,
  href,
  subject,
  onClick,
}: SideBarMenuItemProps) {
  const { pathname } = useLocation();
  const targetPath = path || href || subject;
  const current: boolean = pathname === targetPath;

  return (
    <SideBarMenuItemLink href={href} subject={subject} path={path} clean>
      <SideBarMenuRow
        key={label}
        title={helper}
        onClick={onClick}
        current={current}
      >
        {icon && <SideBarMenuRowIcon>{icon}</SideBarMenuRowIcon>}
        <SideBarMenuRowLabel>{label}</SideBarMenuRowLabel>
        {typeof badge === 'number' && badge > 0 && (
          <SideBarMenuBadge data-testid='sidebar-notification-badge'>
            {badge > 99 ? '99+' : badge}
          </SideBarMenuBadge>
        )}
      </SideBarMenuRow>
    </SideBarMenuItemLink>
  );
}

const SideBarMenuBadge = styled.span`
  flex-shrink: 0;
  margin-left: 0.4rem;
  min-width: 1.25rem;
  padding: 0.05rem 0.4rem;
  border-radius: 1em;
  font-size: 0.7rem;
  font-weight: 600;
  text-align: center;
  background: ${p => p.theme.colors.main};
  color: ${p => p.theme.colors.bg};
`;

/** Icon column for APP menu rows and Shared with me (matches tree LeadingSlot). */
export const SideBarMenuRowIcon = styled.span`
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  width: 1.5rem;
  margin-right: 0.4rem;

  svg {
    font-size: 0.8rem;
  }
`;
