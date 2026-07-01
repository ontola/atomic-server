import { useDndMonitor, useDroppable } from '@dnd-kit/core';
import { styled } from 'styled-components';
import { useState } from 'react';
import { transition } from '../../../helpers/transition';
import { SideBarDropData } from '../useSidebarDnd';
import { useCanWrite, useResource } from '@tomic/react';
import { SIDEBAR_WIDTH_PROP } from '../SidebarCSSVars';

interface DropEdgeProps {
  parentHierarchy: string[];
  /** Stable index used only to give each edge a unique droppable id. */
  index: number;
  /** Subject of the sibling immediately above this edge — undefined when
   *  the edge sits at the very top of a folder's children. */
  prevSubject?: string;
  /** Subject of the sibling immediately below this edge — undefined when
   *  the edge sits at the very bottom. */
  nextSubject?: string;
}

export function DropEdge({
  parentHierarchy,
  index,
  prevSubject,
  nextSubject,
}: DropEdgeProps): React.JSX.Element {
  if (parentHierarchy.length === 0) {
    throw new Error('renderedHierargy should not be empty');
  }

  const [activeDraggedSubject, setDraggingSubject] = useState<string>();

  const parent = parentHierarchy.at(-1)!;

  const parentResource = useResource(parent);

  const canWrite = useCanWrite(parentResource);
  useDndMonitor({
    onDragStart: event => setDraggingSubject(event.active.id as string),
    onDragEnd: () => setDraggingSubject(undefined),
  });

  const data: SideBarDropData = {
    parent,
    prevSubject,
    nextSubject,
  };

  const { setNodeRef, isOver } = useDroppable({
    id: `${parent}-edge-${index}`,
    data,
  });

  if (!canWrite) {
    return <></>;
  }

  // Hide while no drag is active, or when the dragged subject is an
  // ancestor of this edge's parent (cycle prevention — matches the
  // disable-on-cycle check in ResourceSideBar). Also hide the two edges
  // immediately adjacent to the dragged item, since dropping there is a
  // no-op the handler bails on anyway.
  const shouldRender =
    !!activeDraggedSubject &&
    !parentHierarchy.includes(activeDraggedSubject) &&
    activeDraggedSubject !== prevSubject &&
    activeDraggedSubject !== nextSubject;

  return (
    <DropEdgeElement ref={setNodeRef} active={isOver} visible={shouldRender} />
  );
}

/**
 * Hit area is 12px tall but the visible bar is only 3px (centred via
 * a flex column). Without the larger hit zone, dnd-kit's
 * `closestCenter` picks the adjacent 30px row over the 3px edge
 * almost every time — that's how "drop at the top of a folder" used
 * to land on the parent row's "drop onto folder" target and append at
 * the end instead of prepending. Z-index keeps the edge above
 * neighbouring rows when their hit areas overlap.
 */
const DropEdgeElement = styled.div<{ visible: boolean; active: boolean }>`
  display: ${p => (p.visible ? 'flex' : 'none')};
  align-items: center;
  position: absolute;
  left: 0;
  height: 12px;
  margin-top: -6px;
  z-index: 3;
  width: calc(${SIDEBAR_WIDTH_PROP.var()} - 2rem);

  &::before {
    content: '';
    display: block;
    width: 100%;
    height: 3px;
    border-radius: 1.5px;
    background: ${p => p.theme.colors.main};
    opacity: ${p => (p.active ? 1 : 0)};
    transform: scaleX(${p => (p.active ? 1 : 0.9)});
    ${transition('opacity', 'transform')}
  }
`;
