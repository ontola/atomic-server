import {
  forwardRef,
  useState,
  useImperativeHandle,
  useId,
  useCallback,
} from 'react';
import { styled } from 'styled-components';
import { ScrollArea } from '../../../components/ScrollArea';
import type { SuggestionItem } from '../types';
import { useOnValueChange } from '@helpers/useOnValueChange';
import { Column } from '@components/Row';
import { withAlpha } from '../../../styles/withAlpha';

export type CommandListRefType = {
  onKeyDown: (event: KeyboardEvent) => boolean;
};

export interface CommandListProps {
  items: SuggestionItem[];
  command: (item: SuggestionItem) => void;
}

const buildItemId = (compId: string, index: number) =>
  `command-list-${compId}-item-${index}`;

const scrollToSelectedItem = (compId: string, index: number) =>
  document
    .getElementById(buildItemId(compId, index))
    ?.scrollIntoView({ block: 'nearest' });

export const CommandList = forwardRef<CommandListRefType, CommandListProps>(
  ({ items, command }, ref) => {
    const compId = useId();

    const [selectedIndex, setSelectedIndex] = useState(0);

    const selectItem = useCallback(
      (index: number) => {
        const item = items[index];

        if (item) {
          command(item);
        }
      },
      [command, items],
    );

    useOnValueChange(() => setSelectedIndex(0), [items]);

    useImperativeHandle(
      ref,
      () => ({
        onKeyDown: event => {
          if (event.key === 'ArrowUp') {
            const index = (selectedIndex + items.length - 1) % items.length;
            setSelectedIndex(index);

            scrollToSelectedItem(compId, index);

            return true;
          }

          if (event.key === 'ArrowDown') {
            const index = (selectedIndex + 1) % items.length;
            setSelectedIndex(index);

            scrollToSelectedItem(compId, index);

            return true;
          }

          if (event.key === 'Enter') {
            selectItem(selectedIndex);

            return true;
          }

          return false;
        },
      }),
      [selectedIndex, items, compId, selectItem],
    );

    return (
      <ScrollingList type='hover' data-testid='rte-command-list'>
        <ContainedColumn gap='0'>
          {items.length === 0 && <div>No results found</div>}
          {items.map((item, index) => {
            const Icon = item.icon;

            return (
              <ListItemButton
                key={item.id}
                id={buildItemId(compId, index)}
                onClick={() => selectItem(index)}
                onMouseEnter={() => setSelectedIndex(index)}
                active={selectedIndex === index}
              >
                <Icon />
                <span>{item.title}</span>
              </ListItemButton>
            );
          })}
        </ContainedColumn>
      </ScrollingList>
    );
  },
);

CommandList.displayName = 'CommandList';

const ScrollingList = styled(ScrollArea)`
  background-color: var(--color-bg);
  border-radius: var(--radius-md);
  box-shadow: var(--elevation-2);
  padding: 1rem;
  max-height: min(50dvh, 20rem);
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
  align-items: flex-start;
  @supports (backdrop-filter: blur(5px)) {
    background-color: ${withAlpha('var(--color-bg)', 0.85)};
    backdrop-filter: blur(5px);
  }
`;

const ListItemButton = styled.button<{ active: boolean }>`
  appearance: none;
  background: ${p => (p.active ? 'var(--color-accent)' : 'transparent')};
  color: ${p => (p.active ? 'var(--color-bg)' : 'var(--color-text)')};
  border: none;
  display: flex;
  align-items: center;
  gap: 1ch;
  padding: 0.5rem;
  border-radius: var(--radius-md);
  max-width: 60ch;
  overflow: hidden;

  & > svg {
    min-width: 1rem;
    flex-basis: 1rem;
  }

  & > span {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
`;

const ContainedColumn = styled(Column)``;
