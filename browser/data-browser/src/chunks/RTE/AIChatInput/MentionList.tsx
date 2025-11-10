import { forwardRef, useImperativeHandle } from 'react';
import styled from 'styled-components';
import { getIconForClass } from '../../../helpers/iconMap';
import { useSelectedIndex } from '../../../hooks/useSelectedIndex';
import { FaAtom, FaServer } from 'react-icons/fa6';
import type {
  CategorySuggestion,
  AtomicResourceSuggestion,
  SearchSuggestion,
  MCPResourceSuggestion,
} from './types';

export interface MentionListProps {
  items: SearchSuggestion[];
  query: string;
  onSelect: (item: SearchSuggestion) => void;
}

export interface MentionListRef {
  onKeyDown: ({ event }: { event: React.KeyboardEvent<unknown> }) => boolean;
}

export const MentionList = forwardRef<MentionListRef, MentionListProps>(
  ({ items, onSelect, query }, ref) => {
    const { selectedIndex, onKeyDown, onMouseOver, onClick } = useSelectedIndex(
      items,
      index => {
        if (index === undefined) {
          return;
        }

        const item = items[index];

        if (item) {
          onSelect(item);
        }
      },
      { initialIndex: 0, key: query },
    );

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
          items.map((item, index) => {
            const commonProps = {
              selected: index === selectedIndex,
              onMouseOver: () => onMouseOver(index),
              onClick: () => onClick(index),
            };

            if (isAtomicResourceSuggestion(item)) {
              return (
                <AtomicResourceItem
                  key={item.id}
                  item={item}
                  {...commonProps}
                />
              );
            }

            if (isCategorySuggestion(item)) {
              return (
                <CategoryItem key={item.id} item={item} {...commonProps} />
              );
            }

            if (isMCPResourceSuggestion(item)) {
              return (
                <MCPResourceItem key={item.id} item={item} {...commonProps} />
              );
            }

            throw new Error(`Unknown suggestion type`);
          })
        ) : (
          <div className='item'>No result</div>
        )}
      </DropdownMenu>
    );
  },
);

MentionList.displayName = 'MentionList';

interface DropdownItemProps<T extends SearchSuggestion> {
  item: T;
  selected: boolean;
  onClick: () => void;
  onMouseOver: () => void;
}

const AtomicResourceItem: React.FC<
  DropdownItemProps<AtomicResourceSuggestion>
> = ({ item, selected, onClick, onMouseOver }) => {
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

const CategoryItem: React.FC<DropdownItemProps<CategorySuggestion>> = ({
  item,
  selected,
  onClick,
  onMouseOver,
}) => {
  const Icon = item.id === 'category-atomic-data' ? FaAtom : FaServer;

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

const MCPResourceItem: React.FC<DropdownItemProps<MCPResourceSuggestion>> = ({
  item,
  selected,
  onClick,
  onMouseOver,
}) => {
  return (
    <button
      className={selected ? 'is-selected' : ''}
      onClick={onClick}
      // Focus is handled by selectedIndex
      // eslint-disable-next-line jsx-a11y/mouse-events-have-key-events
      onMouseOver={onMouseOver}
    >
      {item.label}
    </button>
  );
};

const isAtomicResourceSuggestion = (
  item: SearchSuggestion,
): item is AtomicResourceSuggestion => {
  return item.type === 'atomic-resource';
};

const isCategorySuggestion = (
  item: SearchSuggestion,
): item is CategorySuggestion => {
  return item.type === 'category';
};

const isMCPResourceSuggestion = (
  item: SearchSuggestion,
): item is MCPResourceSuggestion => {
  return item.type === 'mcp-resource';
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
