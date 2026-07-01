import { forwardRef, useImperativeHandle } from 'react';
import styled from 'styled-components';
import { getIconForClass } from '../../../helpers/iconMap';
import { useSelectedIndex } from '../../../hooks/useSelectedIndex';
import {
  FaAtom,
  FaServer,
  FaTerminal,
  FaWandMagicSparkles,
  FaRobot,
  FaUser,
} from 'react-icons/fa6';
import type {
  CategorySuggestion,
  AtomicResourceSuggestion,
  CommandSuggestion,
  SearchSuggestion,
  MCPResourceSuggestion,
  SkillSuggestion,
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

            if (isSkillSuggestion(item)) {
              return <SkillItem key={item.id} item={item} {...commonProps} />;
            }

            if (isCommandSuggestion(item)) {
              return <CommandItem key={item.id} item={item} {...commonProps} />;
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

const SkillItem: React.FC<DropdownItemProps<SkillSuggestion>> = ({
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
      <FaWandMagicSparkles />
      <SkillItemContent>
        <span>{item.label}</span>
        <SkillDescription>{item.description}</SkillDescription>
      </SkillItemContent>
    </button>
  );
};

const COMMAND_ICONS: Record<CommandSuggestion['id'], React.ComponentType> = {
  compact: FaTerminal,
  skill: FaWandMagicSparkles,
  model: FaRobot,
  agent: FaUser,
};

const CommandItem: React.FC<DropdownItemProps<CommandSuggestion>> = ({
  item,
  selected,
  onClick,
  onMouseOver,
}) => {
  const Icon = COMMAND_ICONS[item.id];

  return (
    <button
      className={selected ? 'is-selected' : ''}
      onClick={onClick}
      // Focus is handled by selectedIndex
      // eslint-disable-next-line jsx-a11y/mouse-events-have-key-events
      onMouseOver={onMouseOver}
    >
      <Icon />
      <SkillItemContent>
        <span>/{item.label}</span>
        <SkillDescription>{item.description}</SkillDescription>
      </SkillItemContent>
    </button>
  );
};

const isCommandSuggestion = (
  item: SearchSuggestion,
): item is CommandSuggestion => {
  return item.type === 'slash-command';
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

const isSkillSuggestion = (item: SearchSuggestion): item is SkillSuggestion => {
  return item.type === 'skill';
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
  max-height: min(50dvh, 20rem);

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

const SkillItemContent = styled.span`
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 0.1rem;
  overflow: hidden;
`;

const SkillDescription = styled.span`
  font-size: 0.8rem;
  color: ${p => p.theme.colors.textLight};
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 40ch;

  button.is-selected & {
    color: ${p => p.theme.colors.mainSelectedFg};
    opacity: 0.8;
  }
`;
