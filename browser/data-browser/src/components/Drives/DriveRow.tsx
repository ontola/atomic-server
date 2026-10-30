import type { ReactNode } from 'react';
import { styled } from 'styled-components';

import { FaRegCircle, FaSquareCheck, FaXmark } from 'react-icons/fa6';
import {
  core,
  server,
  useResourceSnapshot,
  useString,
  useArray,
} from '@tomic/react';
import { driveListStatus } from '../../helpers/driveListStatus';
import { ResourceContextMenu } from '../ResourceContextMenu';
import { FavoriteButton } from './FavoriteButton';
import { IconButton } from '../../components/IconButton/IconButton';
import { PrivateDriveBadge } from './PrivateDriveBadge';

export interface DriveRowProps {
  subject: string;
  label?: string;
  /** This is the drive the app is currently on. */
  selected?: boolean;
  /** The private drive can't be starred or unstarred — it's always yours. */
  hideFavorite?: boolean;
  /**
   * Marks this row as the private drive.
   *
   * It sits in the same list as everything else, so the badge is what keeps it
   * from reading as an ordinary drive that happens to be first.
   */
  isPrivate?: boolean;
  /** Omit for a display-only row in a confirmation or removed-drives list. */
  onClick?: (subject: string) => void;
  actions?: ReactNode;
  onRemove?: (subject: string) => void;
  managing?: boolean;
  checked?: boolean;
  disabled?: boolean;
  onToggle?: (subject: string) => void;
  onDeleted?: (subject: string) => void;
}

export function DriveRow({
  subject,
  label,
  selected,
  hideFavorite,
  isPrivate,
  onClick,
  onRemove,
  managing,
  checked,
  disabled,
  onToggle,
  onDeleted,
  actions,
}: DriveRowProps) {
  const { resource, ready, error, loading } = useResourceSnapshot(subject, {
    allowIncomplete: true,
  });
  const [name] = useString(resource, core.properties.name);
  const [classes] = useArray(resource, core.properties.isA);
  const displayName = (typeof name === 'string' && name) || label || subject;
  const status = driveListStatus(error, loading);
  const interactive = !!(managing || onClick);
  const showAddress =
    (!interactive || managing || !!status) && displayName !== subject;

  return (
    <Wrapper>
      <Choice
        as={interactive ? 'button' : 'div'}
        type={interactive ? 'button' : undefined}
        role={interactive ? (managing ? 'checkbox' : 'radio') : undefined}
        aria-checked={
          interactive ? (managing ? !!checked : !!selected) : undefined
        }
        disabled={interactive ? disabled || (managing && isPrivate) : undefined}
        $interactive={interactive}
        $selected={!!selected}
        onClick={() => (managing ? onToggle?.(subject) : onClick?.(subject))}
      >
        {interactive &&
          ((managing ? checked : selected) ? (
            <FaSquareCheck />
          ) : (
            <FaRegCircle />
          ))}
        <Name>
          <span>{displayName}</span>
          {showAddress && <Address title={subject}>{subject}</Address>}
          {status && <Status title={error?.message}>{status}</Status>}
        </Name>
        {isPrivate && <PrivateDriveBadge />}
      </Choice>
      <Actions>
        {actions}
        {interactive && !managing && !hideFavorite && (
          <FavoriteButton subject={subject} />
        )}
        {managing &&
          !isPrivate &&
          !error &&
          ready &&
          classes.includes(server.classes.drive) && (
            <ResourceContextMenu
              subject={subject}
              title='Drive actions'
              simple
              onAfterDelete={() => onDeleted?.(subject)}
            />
          )}
        {onRemove && !isPrivate && (
          <IconButton
            title='Remove drive from list'
            disabled={disabled}
            onClick={() => onRemove(subject)}
          >
            <FaXmark />
          </IconButton>
        )}
      </Actions>
    </Wrapper>
  );
}

const Wrapper = styled.div`
  display: flex;
  align-items: center;
  /* Padding only on the right: the choice pays its own leading space, so its
     hover state starts at the card's edge rather than inside a gutter. */
  padding-right: 0.5rem;

  &:hover {
    background-color: ${p => p.theme.colors.bg1};
  }
`;

const Choice = styled.button<{ $selected: boolean; $interactive: boolean }>`
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 0.6rem;
  background: none;
  border: none;
  padding: 0.5rem 0.75rem;
  cursor: ${p => (p.$interactive ? 'pointer' : 'default')};
  color: inherit;
  font-size: inherit;
  text-align: left;

  svg {
    flex-shrink: 0;
    color: ${p =>
      p.$selected ? p.theme.colors.main : p.theme.colors.textLight};
  }

  &:focus-visible {
    outline: 2px solid ${p => p.theme.colors.main};
    outline-offset: -2px;
  }
`;

const Name = styled.span`
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 0.2rem;
  overflow-wrap: anywhere;
`;

const Actions = styled.div`
  display: flex;
  align-items: center;
  gap: 0.25rem;
  flex-shrink: 0;
`;

const Address = styled.small`
  color: ${p => p.theme.colors.textLight};
  font-size: 0.75rem;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
`;

const Status = styled.small`
  color: ${p => p.theme.colors.textLight};
  font-size: 0.8rem;
`;
