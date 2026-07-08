import { Property } from '@tomic/react';
import { useDroppable } from '@dnd-kit/core';
import { styled } from 'styled-components';
import { useCallback, useRef, useState, type JSX } from 'react';
import { FaPlus } from 'react-icons/fa6';
import { Tag } from '@components/Tag';
import { IconButton } from '@components/IconButton/IconButton';
import { InputStyled } from '@components/forms/InputStyles';
import { KanbanCard } from './KanbanCard';

/** Column id used for the bucket of cards that have no group-by value set. */
export const UNCATEGORIZED_COLUMN_ID = '__uncategorized__';

interface KanbanColumnProps {
  /** dnd-kit droppable id; a tag subject, or UNCATEGORIZED_COLUMN_ID. */
  columnId: string;
  /** The tag subject to render as the header, or undefined for uncategorized. */
  tagSubject: string | undefined;
  cardSubjects: string[];
  fields: Property[];
  readOnly: boolean;
  /** Create a card in this column (its enum value is preset by the parent). */
  onAddCard: (name: string) => void | Promise<void>;
  /** Open a card's row in the expanded (modal) view. */
  onOpenCard: (subject: string) => void;
}

export function KanbanColumn({
  columnId,
  tagSubject,
  cardSubjects,
  fields,
  readOnly,
  onAddCard,
  onOpenCard,
}: KanbanColumnProps): JSX.Element {
  const { setNodeRef, isOver } = useDroppable({
    id: columnId,
    data: { tagSubject },
  });

  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  const submit = useCallback(() => {
    const trimmed = draft.trim();

    if (trimmed) {
      void onAddCard(trimmed);
    }

    // Keep the input open and focused for rapid entry, like Trello.
    setDraft('');
    inputRef.current?.focus();
  }, [draft, onAddCard]);

  const openAdder = useCallback(() => {
    setAdding(true);
    // Focus after the input mounts.
    window.setTimeout(() => inputRef.current?.focus(), 0);
  }, []);

  return (
    <Column data-testid='kanban-column'>
      <ColumnHeader>
        {tagSubject ? (
          <Tag subject={tagSubject} />
        ) : (
          <NoStatus>No status</NoStatus>
        )}
        <Count data-testid='kanban-column-count'>{cardSubjects.length}</Count>
        {!readOnly && (
          <HeaderAdd title='Add card' type='button' onClick={openAdder}>
            <FaPlus />
          </HeaderAdd>
        )}
      </ColumnHeader>
      <CardList
        ref={setNodeRef}
        $over={isOver}
        data-testid='kanban-column-body'
      >
        {cardSubjects.map(subject => (
          <KanbanCard
            key={subject}
            subject={subject}
            columnId={columnId}
            fields={fields}
            readOnly={readOnly}
            onOpen={onOpenCard}
          />
        ))}
        {!readOnly &&
          (adding ? (
            <AddInput
              ref={inputRef}
              placeholder='Card title…'
              value={draft}
              onChange={e => setDraft(e.target.value)}
              onKeyDown={e => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  submit();
                } else if (e.key === 'Escape') {
                  setDraft('');
                  setAdding(false);
                }
              }}
              onBlur={() => {
                if (draft.trim()) {
                  submit();
                }

                setAdding(false);
              }}
            />
          ) : (
            <AddButton type='button' onClick={openAdder}>
              <FaPlus /> Add card
            </AddButton>
          ))}
      </CardList>
    </Column>
  );
}

const Column = styled.div`
  display: flex;
  flex-direction: column;
  min-width: 16rem;
  max-width: 20rem;
  flex: 1 0 16rem;
  /* Allow the inner card list to own the overflow instead of the column. */
  min-height: 0;
  height: 100%;
`;

const ColumnHeader = styled.div`
  display: flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0.25rem 0.25rem 0.5rem;
  /* Stays put while the card list below scrolls. */
  flex-shrink: 0;
`;

const NoStatus = styled.span`
  color: ${p => p.theme.colors.textLight};
  font-style: italic;
`;

const Count = styled.span`
  color: ${p => p.theme.colors.textLight};
  font-size: 0.85em;
`;

const HeaderAdd = styled(IconButton)`
  margin-left: auto;
  height: 1.6rem;
  width: 1.6rem;
`;

const AddButton = styled.button`
  display: flex;
  align-items: center;
  gap: 0.4rem;
  padding: 0.5rem;
  border: none;
  border-radius: ${p => p.theme.radius};
  background-color: transparent;
  color: ${p => p.theme.colors.textLight};
  cursor: pointer;
  font-size: 0.9em;

  &:hover {
    background-color: ${p => p.theme.colors.bg1};
    color: ${p => p.theme.colors.text};
  }
`;

const AddInput = styled(InputStyled)`
  /* Don't let the base input's fill-height stretch it down the flex column. */
  flex: 0 0 auto;
  height: auto;
  min-height: 2.4rem;
  padding: 0.5rem 0.6rem;
  border: 1px solid ${p => p.theme.colors.main};
  border-radius: ${p => p.theme.radius};
  background-color: ${p => p.theme.colors.bg};
`;

const CardList = styled.div<{ $over: boolean }>`
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
  padding: 0.5rem;
  /* The scroll region: takes the remaining column height and scrolls its own
   * cards, so dragging a card to the bottom auto-scrolls here (dnd-kit targets
   * the nearest scrollable ancestor) rather than the page. */
  flex: 1;
  min-height: 4rem;
  overflow-y: auto;
  border-radius: ${p => p.theme.radius};
  background-color: ${p =>
    p.$over ? p.theme.colors.bg1 : p.theme.colors.bgBody};
  border: 1px dashed ${p => (p.$over ? p.theme.colors.main : 'transparent')};
  transition:
    background-color 0.1s ease-in-out,
    border-color 0.1s ease-in-out;
`;
