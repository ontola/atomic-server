import { styled } from 'styled-components';
import { AtomicLink, AtomicLinkProps } from '../AtomicLink';
import { SideBarItem } from './SideBarItem';
import { useLocation } from '@tanstack/react-router';

export interface SideBarMenuItemProps extends AtomicLinkProps {
  label: string;
  helper?: string;
  icon?: React.ReactNode;
  disabled?: boolean;
  /** Is called when clicking on the item. Used for closing the menu. */
  onClick?: () => void;
}

export function SideBarMenuItem({
  helper,
  label,
  icon,
  path,
  href,
  subject,
  onClick,
}: SideBarMenuItemProps) {
  const { pathname } = useLocation();
  const targetPath = path || href || subject;
  const current: boolean = pathname === targetPath;

  return (
    <AtomicLink href={href} subject={subject} path={path} clean>
      <SideBarItem
        key={label}
        title={helper}
        onClick={onClick}
        current={current}
      >
        {icon && <SideBarMenuRowIcon>{icon}</SideBarMenuRowIcon>}
        {label}
      </SideBarItem>
    </AtomicLink>
  );
}

/** Icon column for APP menu rows and Shared with me (matches alignment). */
export const SideBarMenuRowIcon = styled.span`
  display: flex;
  margin-right: 0.5rem;
  font-size: 1.5rem;
`;
