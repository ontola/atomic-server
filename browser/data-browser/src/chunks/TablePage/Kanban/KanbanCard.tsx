import {
  Property,
  core,
  useResource,
  useStore,
  useTitle,
  useProperty,
} from '@tomic/react';
import { useDndContext, useDraggable, useDroppable } from '@dnd-kit/core';
import { styled } from 'styled-components';
import {
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type JSX,
} from 'react';
import { FaUpRightFromSquare } from 'react-icons/fa6';
import ValueComp from '@components/ValueComp';
import { useResourceContextMenu } from '@components/ResourceContextMenu/ResourceContextMenuContext';
import { RemoteCellPresence, TablePresenceContext } from '../TablePresence';
import { useCardFlip } from './cardFlip';
import { caretOffsetAt } from '@helpers/caretOffsetAt';

interface KanbanCardProps {
  subject: string;
  /** The column this card renders in — enables the FLIP move animation.
   *  Unset for the DragOverlay copy (it must not touch the registry). */
  columnId?: string;
  /** Fields to preview on the card (already excludes the group-by property). */
  fields: Property[];
  readOnly: boolean;
  /** Open the row in the expanded (modal) view. */
  onOpen?: (subject: string) => void;
}

/**
 * A single row rendered as a draggable kanban card. dnd-kit's MouseSensor only
 * starts a drag after 10px of movement, so a plain click still opens the row.
 */
export function KanbanCard({
  subject,
  columnId,
  fields,
  readOnly,
  onOpen,
}: KanbanCardProps): JSX.Element {
  const store = useStore();
  const resource = useResource(subject);
  const [title] = useTitle(resource);
  const { openResourceMenu } = useResourceContextMenu();

  // Presence: which remote sessions are on this card (hover, a selected
  // cell in the grid view, or a drag — the ring pulses while they drag),
  // and the announcer for our own hover. The DragOverlay's copy of the
  // card announces nothing: `onOpen` is unset there, and hover can't
  // reach it anyway (it rides under the pointer).
  const { rows, setActiveCard } = useContext(TablePresenceContext);
  const remote = rows.get(resource.subject);
  const remoteDragging = remote?.some(p => p.dragging) ?? false;

  // Where the caret lands when the editor opens: under the click, like any
  // text field. `null` while not editing.
  const [editCaret, setEditCaret] = useState<number | 'end' | null>(null);
  // The title just committed, shown until the resource catches up so the old
  // title doesn't flash back while the write is in flight.
  const [pendingTitle, setPendingTitle] = useState<string>();

  const { attributes, listeners, setNodeRef, setActivatorNodeRef, isDragging } =
    useDraggable({
      id: subject,
      data: { subject },
      disabled: readOnly,
    });

  // Also a drop target: dropping a card ONTO another card reorders it into
  // that card's vertical slot (see KanbanView.handleDragEnd). Disabled on the
  // read-only DragOverlay copy so it doesn't register a duplicate droppable.
  const { setNodeRef: setDropRef } = useDroppable({
    id: subject,
    data: { subject, columnId, isCard: true },
    disabled: readOnly,
  });

  const flipRef = useCardFlip(resource.subject, columnId, isDragging);

  // While ANY drag is live, hover announcements are suppressed: the drag
  // announcement (made by the board) owns our presence entry, and cards
  // passing under the pointer mid-drag would clobber it.
  const { active: dndActive } = useDndContext();

  const announceHover = useCallback(
    (row: string | undefined) => {
      if (!dndActive && onOpen) {
        setActiveCard(row);
      }
    },
    [dndActive, onOpen, setActiveCard],
  );

  const handleClick = useCallback(() => {
    onOpen?.(subject);
  }, [onOpen, subject]);

  const shownTitle = pendingTitle ?? title;

  const startEditing = useCallback(
    (e: React.MouseEvent<HTMLElement>) => {
      // Read-only cards have nothing to edit, so the click opens the card.
      if (readOnly) {
        return;
      }

      // Don't open the resource (card click) — just edit the title in place.
      e.stopPropagation();
      setEditCaret(caretOffsetAt(e.currentTarget, e.clientX, e.clientY));
    },
    [readOnly],
  );

  const commitTitle = useCallback(
    (next: string) => {
      setEditCaret(null);

      if (!next || next === title) {
        return;
      }

      setPendingTitle(next);

      // Save immediately (like a drag), not via a debounced commit — otherwise
      // a reload right after editing can race the pending write and lose it.
      void (async () => {
        await resource.set(core.properties.name, next);
        await resource.save();
      })()
        .catch(e => store.notifyError(e))
        .finally(() => setPendingTitle(undefined));
    },
    [title, resource, store],
  );

  // The DragOverlay renders the moving visual; the source card must NOT also
  // apply the drag transform (that double-moves it and makes dnd-kit's drop
  // animation fly back to the source's old slot). It just dims in place.
  return (
    <Card
      ref={el => {
        flipRef.current = el;
        setNodeRef(el);
        setDropRef(el);
        // Keyboard drags start only from the card itself, so Space and Enter
        // typed into the title editor (or on the open button) stay keystrokes.
        setActivatorNodeRef(el);
      }}
      $dragging={isDragging}
      $remoteDragging={remoteDragging}
      onClick={handleClick}
      onContextMenu={e => openResourceMenu(subject, e)}
      onMouseEnter={() => announceHover(resource.subject)}
      onMouseLeave={() => announceHover(undefined)}
      data-testid='kanban-card'
      data-kanban-card-subject={subject}
      {...listeners}
      {...attributes}
    >
      <CardHead>
        {editCaret !== null ? (
          <CardTitleEditor
            initial={shownTitle ?? ''}
            caret={editCaret}
            onCommit={commitTitle}
            onCancel={() => setEditCaret(null)}
          />
        ) : (
          <CardTitle
            onClick={startEditing}
            title={readOnly ? undefined : 'Click to edit title'}
            $editable={!readOnly}
            data-testid='kanban-card-title'
          >
            <span data-title-text>{shownTitle || subject}</span>
          </CardTitle>
        )}
        {/* Explicit way to open the resource — a title-only card is otherwise
         * all edit-on-click, leaving no plain area to click through. */}
        <OpenButton
          type='button'
          title='Open'
          onClick={e => {
            e.stopPropagation();
            handleClick();
          }}
          {...stopDragProps}
        >
          <FaUpRightFromSquare />
        </OpenButton>
      </CardHead>
      {fields.map(field => (
        <CardField key={field.subject} field={field} resource={resource} />
      ))}
      {remote && remote.length > 0 && (
        <RemoteCellPresence
          agents={remote.map(p => p.agent)}
          dragging={remoteDragging}
        />
      )}
    </Card>
  );
}

/** Keeps dnd-kit's pointer sensors from treating a press as a drag start.
 *  The MouseSensor listens for `mousedown`, not `pointerdown`, so both go. */
const stopDragProps = {
  onPointerDown: (e: React.SyntheticEvent) => e.stopPropagation(),
  onMouseDown: (e: React.SyntheticEvent) => e.stopPropagation(),
  onTouchStart: (e: React.SyntheticEvent) => e.stopPropagation(),
};

interface CardTitleEditorProps {
  initial: string;
  caret: number | 'end';
  /** Called once, with the trimmed title, when editing ends by Enter or blur. */
  onCommit: (title: string) => void;
  onCancel: () => void;
}

/**
 * In-place title editor. A textarea that wraps and grows exactly like the
 * rendered title, so the card keeps its size when editing starts: a card that
 * changes height shifts everything below it, and the next click lands on the
 * wrong card. Every event is kept inside, so the card never opens or starts a
 * drag while you type or select text.
 */
function CardTitleEditor({
  initial,
  caret,
  onCommit,
  onCancel,
}: CardTitleEditorProps): JSX.Element {
  const [draft, setDraft] = useState(initial);
  const ref = useRef<HTMLTextAreaElement>(null);
  // Enter commits and unmounts; the blur that can follow must not commit
  // again (or commit after a cancel).
  const doneRef = useRef(false);

  const finish = (commit: boolean) => {
    if (doneRef.current) {
      return;
    }

    doneRef.current = true;

    if (commit) {
      onCommit(draft.trim());
    } else {
      onCancel();
    }
  };

  useEffect(() => {
    const el = ref.current;

    if (!el) {
      return;
    }

    el.focus();
    const at = caret === 'end' ? el.value.length : caret;
    el.setSelectionRange(at, at);
    // Only on open: the caret must not jump while typing.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Grow with the text, measured before paint so the box never flashes at
  // one row.
  useLayoutEffect(() => {
    const el = ref.current;

    if (!el) {
      return;
    }

    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight}px`;
  }, [draft]);

  return (
    <TitleInput
      ref={ref}
      rows={1}
      value={draft}
      aria-label='Title'
      data-testid='kanban-card-title-input'
      // Titles are one line of text; a pasted newline becomes a space.
      onChange={e => setDraft(e.target.value.replace(/\s*\n\s*/g, ' '))}
      onKeyDown={e => {
        // Nothing typed here is meant for the card (keyboard drag on Space /
        // Enter) or the page's shortcuts.
        e.stopPropagation();

        if (e.key === 'Enter') {
          e.preventDefault();
          finish(true);
        } else if (e.key === 'Escape') {
          e.preventDefault();
          finish(false);
        }
      }}
      onBlur={() => finish(true)}
      onClick={e => e.stopPropagation()}
      onContextMenu={e => e.stopPropagation()}
      {...stopDragProps}
    />
  );
}

function CardField({
  field,
  resource,
}: {
  field: Property;
  resource: ReturnType<typeof useResource>;
}): JSX.Element | null {
  const property = useProperty(field.subject);
  const value = resource.get(field.subject);

  if (value === undefined || value === null || value === '') {
    return null;
  }

  return (
    <FieldRow>
      <FieldLabel>{property.shortname ?? field.subject}</FieldLabel>
      <FieldValue>
        <ValueComp datatype={property.datatype} value={value} />
      </FieldValue>
    </FieldRow>
  );
}

const Card = styled.div<{ $dragging: boolean; $remoteDragging: boolean }>`
  /* Anchor for the presence ring + name tag. */
  position: relative;
  display: flex;
  flex-direction: column;
  gap: 0.35rem;
  padding: 0.6rem 0.75rem;
  background-color: ${p => p.theme.colors.bg};
  border: 1px solid ${p => p.theme.colors.bg2};
  border-radius: ${p => p.theme.radius};
  cursor: pointer;
  box-shadow: ${p =>
    p.$dragging || p.$remoteDragging ? p.theme.boxShadowIntense : 'none'};
  opacity: ${p => (p.$dragging ? 0.6 : 1)};
  /* A slight lift while a REMOTE session drags it — mirrors the drag
   * overlay they see, without moving the card out of its slot. */
  transform: ${p => (p.$remoteDragging ? 'rotate(1.5deg)' : 'none')};
  transition: transform 0.15s ease-in-out;
  user-select: none;

  &:hover {
    border-color: ${p => p.theme.colors.main};
  }
`;

const CardHead = styled.div`
  display: flex;
  align-items: flex-start;
  gap: 0.25rem;
`;

const CardTitle = styled.span<{ $editable: boolean }>`
  flex: 1;
  min-width: 0;
  font-weight: bold;
  line-height: 1.4;
  word-break: break-word;
  white-space: pre-wrap;
  border-radius: ${p => p.theme.radius};
  cursor: ${p => (p.$editable ? 'text' : 'inherit')};

  ${p =>
    p.$editable &&
    `&:hover {
      background-color: ${p.theme.colors.bg1};
      box-shadow: 0 0 0 3px ${p.theme.colors.bg1};
    }`}
`;

const OpenButton = styled.button`
  flex-shrink: 0;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  height: 1.4rem;
  width: 1.4rem;
  border: none;
  border-radius: ${p => p.theme.radius};
  background-color: transparent;
  color: ${p => p.theme.colors.textLight};
  cursor: pointer;
  opacity: 0;
  transition: opacity 0.1s ease-in-out;

  &:hover {
    background-color: ${p => p.theme.colors.bg1};
    color: ${p => p.theme.colors.text};
  }

  ${Card}:hover & {
    opacity: 1;
  }
`;

const TitleInput = styled.textarea`
  /* The exact box and text metrics of CardTitle, so the card doesn't resize
   * when editing starts. The focus ring is a box-shadow: it takes no space. */
  flex: 1;
  min-width: 0;
  display: block;
  margin: 0;
  padding: 0;
  border: none;
  outline: none;
  resize: none;
  overflow: hidden;
  font: inherit;
  font-weight: bold;
  line-height: 1.4;
  word-break: break-word;
  white-space: pre-wrap;
  color: ${p => p.theme.colors.text};
  background-color: ${p => p.theme.colors.bg};
  border-radius: ${p => p.theme.radius};
  box-shadow:
    0 0 0 3px ${p => p.theme.colors.bg},
    0 0 0 4px ${p => p.theme.colors.main};
  cursor: text;
  user-select: text;
`;

const FieldRow = styled.div`
  display: flex;
  gap: 0.5rem;
  align-items: baseline;
  font-size: 0.85em;
  color: ${p => p.theme.colors.textLight};
`;

const FieldLabel = styled.span`
  flex-shrink: 0;
  color: ${p => p.theme.colors.textLight};
`;

const FieldValue = styled.span`
  word-break: break-word;
  min-width: 0;
`;
