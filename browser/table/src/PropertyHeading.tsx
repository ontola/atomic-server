import { useState, type ReactNode, type MouseEventHandler } from 'react';
import { styled } from 'styled-components';
import { FaAngleDown, FaAngleUp, FaGripVertical } from 'react-icons/fa6';
import type { DraggableAttributes } from '@dnd-kit/core';
import type { SyntheticListenerMap } from '@dnd-kit/core/dist/hooks/utilities';

export interface TablePropertyHeadingProps {
  label: string;
  required?: boolean;
  sorted?: 'ascending' | 'descending';
  onSort?: () => void;
  disabled?: boolean;
  sortDescription?: string;
  sortUnavailableReason?: string;
  icon?: ReactNode;
  dragListeners?: SyntheticListenerMap;
  dragAttributes?: DraggableAttributes;
  dragLabel?: string;
  onContextMenu?: MouseEventHandler<HTMLDivElement>;
  /** Backend language selector and property-command menu leaves. */
  children?: ReactNode;
}

/** Actual stored-property heading: sort state/affordance, hover drag handle,
 * required marker and full-height context-menu target are shared. */
export function TablePropertyHeading({
  label,
  required,
  sorted,
  onSort,
  disabled,
  sortDescription,
  sortUnavailableReason,
  icon,
  dragListeners,
  dragAttributes,
  dragLabel = 'Drag column',
  onContextMenu,
  children,
}: TablePropertyHeadingProps) {
  const [hoverOrFocus, setHoverOrFocus] = useState(false);
  const text = `${label}${required ? '*' : ''}`;
  const indicator = sorted ? (
    sorted === 'descending' ? (
      <FaAngleDown />
    ) : (
      <FaAngleUp />
    )
  ) : hoverOrFocus && !disabled && (dragListeners || dragAttributes) ? (
    <FaGripVertical />
  ) : (
    icon
  );

  return (
    <Wrapper
      onMouseEnter={() => setHoverOrFocus(true)}
      onMouseLeave={() => setHoverOrFocus(false)}
      onFocus={() => setHoverOrFocus(true)}
      onBlur={() => setHoverOrFocus(false)}
      onContextMenu={onContextMenu}
    >
      {dragListeners || dragAttributes ? (
        <DragButton
          type='button'
          {...dragListeners}
          {...dragAttributes}
          disabled={disabled}
          title={dragLabel}
          aria-label={dragLabel}
        >
          {indicator ?? <FaGripVertical />}
        </DragButton>
      ) : (
        <Indicator aria-hidden='true'>{indicator}</Indicator>
      )}
      <NameButton
        type='button'
        onClick={onSort}
        disabled={disabled || !onSort}
        $sorted={!!sorted}
        title={sortUnavailableReason ?? text}
        aria-description={
          sortUnavailableReason ?? sortDescription ?? `Sort by ${text}`
        }
      >
        {text}
      </NameButton>
      {children}
    </Wrapper>
  );
}

const Wrapper = styled.div`
  display: flex;
  align-items: center;
  gap: 0.5rem;
  width: 100%;
  align-self: stretch;
  min-width: 0;
`;
const NameButton = styled.button<{ $sorted: boolean }>`
  background: none;
  border: none;
  color: currentColor;
  cursor: pointer;
  font: inherit;
  font-weight: ${p => (p.$sorted ? 'bold' : 'normal')};
  overflow: hidden;
  text-overflow: ellipsis;
  padding: 0;
  &:disabled {
    cursor: default;
  }
`;
const Indicator = styled.span`
  display: inline-flex;
  flex-shrink: 0;
`;
const DragButton = styled.button`
  background: none;
  color: currentColor;
  display: flex;
  align-items: center;
  border: none;
  height: 1rem;
  padding: 0;
  cursor: grab;
  &:active {
    cursor: grabbing;
  }
  svg {
    color: currentColor;
    max-width: 1rem;
    min-width: 1rem;
    flex: 1;
  }
`;
