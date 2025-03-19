import { forwardRef, useEffect, useImperativeHandle, useState } from 'react';
import styled from 'styled-components';

export type SearchSuggestion = {
  id: string;
  label: string;
};
export interface MentionListProps {
  items: SearchSuggestion[];
  command: (item: SearchSuggestion) => void;
}

export interface MentionListRef {
  onKeyDown: ({ event }: { event: KeyboardEvent }) => boolean;
}

export const MentionList = forwardRef<MentionListRef, MentionListProps>(
  ({ items, command }, ref) => {
    const [selectedIndex, setSelectedIndex] = useState(0);

    const selectItem = (index: number) => {
      const item = items[index];

      if (item) {
        command(item);
      }
    };

    const upHandler = () => {
      setSelectedIndex((selectedIndex + items.length - 1) % items.length);
    };

    const downHandler = () => {
      setSelectedIndex((selectedIndex + 1) % items.length);
    };

    const enterHandler = () => {
      selectItem(selectedIndex);
    };

    useEffect(() => setSelectedIndex(0), [items]);

    useImperativeHandle(ref, () => ({
      onKeyDown: ({ event }) => {
        if (event.key === 'ArrowUp') {
          upHandler();

          return true;
        }

        if (event.key === 'ArrowDown') {
          downHandler();

          return true;
        }

        if (event.key === 'Enter') {
          enterHandler();

          return true;
        }

        return false;
      },
    }));

    return (
      <DropdownMenu>
        {items.length ? (
          items.map((item, index) => (
            <button
              className={index === selectedIndex ? 'is-selected' : ''}
              key={item.id}
              onClick={() => selectItem(index)}
            >
              {item.label}
            </button>
          ))
        ) : (
          <div className='item'>No result</div>
        )}
      </DropdownMenu>
    );
  },
);

MentionList.displayName = 'MentionList';

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
    gap: 0.25rem;
    text-align: left;
    width: 100%;

    &:hover,
    &.is-selected {
      background-color: ${p => p.theme.colors.mainSelectedBg};
      color: ${p => p.theme.colors.mainSelectedFg};
    }
  }
`;
