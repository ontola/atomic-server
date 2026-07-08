import {
  Property,
  core,
  useResource,
  useTitle,
  useProperty,
} from '@tomic/react';
import { useDndContext, useDraggable } from '@dnd-kit/core';
import { styled } from 'styled-components';
import { useCallback, useContext, useState, type JSX } from 'react';
import { FaUpRightFromSquare } from 'react-icons/fa6';
import ValueComp from '@components/ValueComp';
import { InputStyled } from '@components/forms/InputStyles';
import { useResourceContextMenu } from '@components/ResourceContextMenu/ResourceContextMenuContext';
import { RemoteCellPresence, TablePresenceContext } from '../TablePresence';
import { useCardFlip } from './cardFlip';

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

  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');

  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: subject,
    data: { subject },
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

  const startEditing = useCallback(
    (e: React.MouseEvent) => {
      // Don't open the resource (card click) — just edit the title in place.
      e.stopPropagation();

      if (readOnly) {
        return;
      }

      setDraft(title ?? '');
      setEditing(true);
    },
    [readOnly, title],
  );

  const commitTitle = useCallback(() => {
    const trimmed = draft.trim();

    setEditing(false);

    if (trimmed && trimmed !== title) {
      // Save immediately (like a drag), not via a debounced commit — otherwise
      // a reload right after editing can race the pending write and lose it.
      void (async () => {
        await resource.set(core.properties.name, trimmed);
        await resource.save();
      })().catch(() => undefined);
    }
  }, [draft, title, resource]);

  // The DragOverlay renders the moving visual; the source card must NOT also
  // apply the drag transform (that double-moves it and makes dnd-kit's drop
  // animation fly back to the source's old slot). It just dims in place.
  return (
    <Card
      ref={el => {
        flipRef.current = el;
        setNodeRef(el);
      }}
      $dragging={isDragging}
      $remoteDragging={remoteDragging}
      onClick={handleClick}
      onContextMenu={e => openResourceMenu(subject, e)}
      onMouseEnter={() => announceHover(resource.subject)}
      onMouseLeave={() => announceHover(undefined)}
      data-testid='kanban-card'
      {...listeners}
      {...attributes}
    >
      <CardHead>
        {editing ? (
          <TitleInput
            autoFocus
            value={draft}
            // Stop drag/navigation from firing while interacting with the input.
            onClick={e => e.stopPropagation()}
            onPointerDown={e => e.stopPropagation()}
            onChange={e => setDraft(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Enter') {
                e.preventDefault();
                commitTitle();
              } else if (e.key === 'Escape') {
                setEditing(false);
              }
            }}
            onBlur={commitTitle}
          />
        ) : (
          <CardTitle onClick={startEditing} title='Click to edit title'>
            {title || subject}
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
          onPointerDown={e => e.stopPropagation()}
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

const CardTitle = styled.span`
  flex: 1;
  font-weight: bold;
  word-break: break-word;
  border-radius: ${p => p.theme.radius};

  &:hover {
    background-color: ${p => p.theme.colors.bg1};
    box-shadow: 0 0 0 3px ${p => p.theme.colors.bg1};
  }
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

const TitleInput = styled(InputStyled)`
  flex: 0 0 auto;
  height: auto;
  font-weight: bold;
  padding: 0.1rem 0.3rem;
  margin: -0.1rem -0.3rem;
  border: 1px solid ${p => p.theme.colors.main};
  border-radius: ${p => p.theme.radius};
  background-color: ${p => p.theme.colors.bg};
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
