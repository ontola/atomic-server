import { forwardRef, useEffect, useImperativeHandle } from 'react';
import styled from 'styled-components';
import { getIconForClass } from '../../../helpers/iconMap';
import { useSelectedIndex } from '../../../hooks/useSelectedIndex';

export type SearchSuggestion = {
  id: string;
  label: string;
  isA: string[];
};
export interface MentionListProps {
  items: SearchSuggestion[];
  command: (item: SearchSuggestion) => void;
}

export interface MentionListRef {
  onKeyDown: ({ event }: { event: React.KeyboardEvent<unknown> }) => boolean;
}

export const MentionList = forwardRef<MentionListRef, MentionListProps>(
  ({ items, command }, ref) => {
    const { selectedIndex, onKeyDown, onMouseOver, onClick, resetIndex } =
      useSelectedIndex(
        items,
        index => {
          if (index === undefined) {
            return;
          }

          const item = items[index];

          if (item) {
            command(item);
          }
        },
        0,
      );

    useEffect(() => resetIndex(), [items]);

    useImperativeHandle(ref, () => ({
      onKeyDown: ({ event }) => {
        onKeyDown(event);

        if (['ArrowDown', 'ArrowUp', 'Enter'].includes(event.key)) {
          return true;
        }

        return false;
      },
    }));

    return (
      <DropdownMenu>
        {items.length ? (
          items.map((item, index) => (
            <DropdownItem
              key={item.id}
              item={item}
              selected={index === selectedIndex}
              onMouseOver={() => onMouseOver(index)}
              onClick={() => onClick(index)}
            />
          ))
        ) : (
          <div className='item'>No result</div>
        )}
      </DropdownMenu>
    );
  },
);

MentionList.displayName = 'MentionList';

interface DropdownItemProps {
  item: SearchSuggestion;
  selected: boolean;
  onClick: () => void;
  onMouseOver: () => void;
}

const DropdownItem = ({
  item,
  selected,
  onClick,
  onMouseOver,
}: DropdownItemProps) => {
  const Icon = getIconForClass(item.isA[0]);

  return (
    <button
      className={selected ? 'is-selected' : ''}
      onClick={onClick}
      // Focus is handled by selectedIndex
      // eslint-disable-next-line jsx-a11y/mouse-events-have-key-events
      onMouseOver={onMouseOver}
    >
      <Icon />
      {item.label}
    </button>
  );
};

const DropdownMenu = styled.div`
  background: ${p => p.theme.colors.bg};
  border-radius: 0.7rem;
  box-shadow: ${p => p.theme.boxShadowIntense};
  display: flex;
  flex-direction: column;
  gap: 0.1rem;
  overflow: auto;
  padding: 0.4rem;
  position: relative;

  button {
    background: transparent;
    appearance: none;
    border: none;
    border-radius: ${p => p.theme.radius};
    display: flex;
    align-items: center;
    gap: ${p => p.theme.size(1)};
    text-align: left;
    width: 100%;
    padding: 0.5rem;
    cursor: pointer;

    &.is-selected {
      background-color: ${p => p.theme.colors.mainSelectedBg};
      color: ${p => p.theme.colors.mainSelectedFg};
    }
  }
`;
