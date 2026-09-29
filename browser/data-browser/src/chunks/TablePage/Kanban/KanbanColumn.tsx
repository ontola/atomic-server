import { Property } from '@tomic/react';
import { useDroppable } from '@dnd-kit/core';
import { styled } from 'styled-components';
import { mix, setLightness } from 'polished';
import { useCallback, useMemo, useRef, useState, type JSX } from 'react';
import { FaEllipsis, FaPlus, FaStar } from 'react-icons/fa6';
import { useTagData } from '@components/Tag';
import { IconButton } from '@components/IconButton/IconButton';
import { SkeletonButton } from '@components/SkeletonButton';
import { InputStyled } from '@components/forms/InputStyles';
import { DropdownMenu, type DropdownItem } from '@components/Dropdown';
import { buildDefaultTrigger } from '@components/Dropdown/DefaultTrigger';
import { KanbanCard } from './KanbanCard';

/** Placeholder subject passed to `useTagData` for the uncategorized column,
 *  which has no tag — its data is loaded but never rendered. */
const NO_TAG_SUBJECT = 'unknown-subject';

/** Column id used for the bucket of cards that have no group-by value set. */
export const UNCATEGORIZED_COLUMN_ID = '__uncategorized__';

interface KanbanColumnProps {
  /** dnd-kit droppable id; a tag subject, or UNCATEGORIZED_COLUMN_ID. */
  columnId: string;
  /** The tag subject to render as the header, or undefined for uncategorized. */
  tagSubject: string | undefined;
  cardSubjects: string[];
  fields: Property[];
  /** Singular label for a row of this table (e.g. "Issue"), used in the
   *  "Add …" affordances instead of a hardcoded "card". */
  rowName: string;
  readOnly: boolean;
  /** True when the dragged card would drop into this column — highlights the
   *  whole column. Replaces the raw `isOver` flag, which never fired for a
   *  column that already had cards (a card intercepts the drop target). */
  isDropTarget?: boolean;
  /** Whether new rows, added from any view, start in this column. */
  isDefault?: boolean;
  /** Make this the column new rows start in (`true`) or stop that (`false`).
   *  Absent for the "No status" column. */
  onSetDefault?: (isDefault: boolean) => void;
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
  rowName,
  readOnly,
  isDropTarget = false,
  isDefault = false,
  onSetDefault,
  onAddCard,
  onOpenCard,
}: KanbanColumnProps): JSX.Element {
  const { setNodeRef } = useDroppable({
    id: columnId,
    data: { tagSubject },
  });

  const { color: tagColor, text: tagText } = useTagData(
    tagSubject ?? NO_TAG_SUBJECT,
  );
  const headerColor = tagSubject ? setLightness(0.38, tagColor) : undefined;

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

  const lowerRowName = rowName.toLowerCase();
  const menuItems = useMemo(
    (): DropdownItem[] =>
      onSetDefault
        ? [
            {
              id: 'default-lane',
              label: isDefault
                ? `Stop starting new ${lowerRowName}s here`
                : `Start new ${lowerRowName}s here`,
              icon: <FaStar />,
              onClick: () => onSetDefault(!isDefault),
            },
          ]
        : [],
    [onSetDefault, isDefault, lowerRowName],
  );

  const openAdder = useCallback(() => {
    setAdding(true);
    // Focus after the input mounts.
    window.setTimeout(() => inputRef.current?.focus(), 0);
  }, []);

  return (
    <Column data-testid='kanban-column'>
      <ColumnHeader $bg={headerColor}>
        {tagSubject ? (
          <ColumnHeaderTitle>{tagText}</ColumnHeaderTitle>
        ) : (
          <NoStatus>No status</NoStatus>
        )}
        {isDefault && (
          <DefaultMark
            data-testid='kanban-column-default'
            title={`New ${lowerRowName}s start here`}
          >
            <FaStar />
          </DefaultMark>
        )}
        <Count data-testid='kanban-column-count'>{cardSubjects.length}</Count>
        {!readOnly && (
          <HeaderAdd title={`Add ${rowName}`} type='button' onClick={openAdder}>
            <FaPlus />
          </HeaderAdd>
        )}
        {!readOnly && menuItems.length > 0 && (
          <DropdownMenu Trigger={LaneMenuTrigger} items={menuItems} />
        )}
      </ColumnHeader>
      <CardList
        ref={setNodeRef}
        $over={isDropTarget}
        $tint={headerColor}
        data-testid='kanban-column-body'
        data-kanban-column-id={columnId}
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
              placeholder={`${rowName} title…`}
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
              <FaPlus /> Add {rowName}
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
  /* Header + card list are one continuous rounded card; this clips both to
   * match the outer radius instead of each rounding its own corners. */
  border-radius: ${p => p.theme.radius};
  overflow: hidden;
`;

const ColumnHeader = styled.div<{ $bg: string | undefined }>`
  display: flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0.6rem 0.75rem;
  /* Stays put while the card list below scrolls. */
  flex-shrink: 0;
  background-color: ${p => p.$bg ?? p.theme.colors.bg2};
  color: ${p => (p.$bg ? 'white' : p.theme.colors.textLight)};
`;

const ColumnHeaderTitle = styled.span`
  font-weight: bold;
  font-size: 1.05em;
`;

const NoStatus = styled.span`
  font-style: italic;
`;

const Count = styled.span`
  font-size: 0.85em;
  opacity: 0.8;
`;

const DefaultMark = styled.span`
  display: inline-flex;
  font-size: 0.75em;
  opacity: 0.85;
`;

const HeaderButton = styled(IconButton)`
  height: 1.6rem;
  width: 1.6rem;
  color: inherit;

  &:not([disabled]):hover,
  &:not([disabled]):focus-visible {
    background-color: rgba(255, 255, 255, 0.25);
  }
`;

const HeaderAdd = styled(HeaderButton)`
  margin-left: auto;
`;

const LaneMenuTrigger = buildDefaultTrigger(
  <FaEllipsis />,
  'Lane options',
  HeaderButton,
);

const AddButton = styled(SkeletonButton)`
  justify-content: flex-start;
  padding: 0.6rem 0.75rem;
  font-size: 0.9em;
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

const CardList = styled.div<{ $over: boolean; $tint: string | undefined }>`
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
  background-color: ${p => {
    if (p.$over) {
      return p.theme.colors.bg2;
    }

    // A faint wash of the header's hue over the usual grey — close enough
    // to bg1 that it still reads as neutral, but ties the card list to its
    // column.
    return p.$tint
      ? mix(0.08, p.$tint, p.theme.colors.bg1)
      : p.theme.colors.bg1;
  }};
  border: 1px dashed ${p => (p.$over ? p.theme.colors.main : 'transparent')};
  transition:
    background-color 0.1s ease-in-out,
    border-color 0.1s ease-in-out;
`;
