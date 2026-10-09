import { useDroppable } from '@dnd-kit/core';
import { useCanWrite, useResource } from '@tomic/react';
import { createPortal } from 'react-dom';
import { FaStar, FaTrash } from 'react-icons/fa6';
import { styled } from 'styled-components';
import { transition } from '../../helpers/transition';
import type { SideBarZoneData, SideBarZoneKind } from './useSidebarDnd';

interface SidebarDropZonesProps {
  /** Subject being dragged. The zones only exist while this is set. */
  draggingResource: string | undefined;
}

/**
 * Favorites and Trash targets pinned to the bottom-left of the screen while a
 * sidebar item is dragged. Rendered in a portal so they stay visible however
 * far the tree is scrolled, and big enough to hit with a thumb.
 */
export function SidebarDropZones({
  draggingResource,
}: SidebarDropZonesProps): React.JSX.Element | null {
  if (!draggingResource) {
    return null;
  }

  return createPortal(
    <ZoneBar data-testid='sidebar-drop-zones'>
      <TrashZone subject={draggingResource} />
      <DropZone
        zone='favorites'
        icon={<FaStar />}
        testId='sidebar-zone-favorites'
      >
        Favorites
      </DropZone>
    </ZoneBar>,
    document.body,
  );
}

/** Trash is only offered for items the agent may move. */
function TrashZone({ subject }: { subject: string }) {
  const resource = useResource(subject);
  const canWrite = useCanWrite(resource);

  if (!canWrite) {
    return null;
  }

  return (
    <DropZone
      zone='trash'
      icon={<FaTrash />}
      testId='sidebar-zone-trash'
      danger
    >
      Delete
    </DropZone>
  );
}

interface DropZoneProps {
  zone: SideBarZoneKind;
  icon: React.ReactNode;
  testId: string;
  danger?: boolean;
}

function DropZone({
  zone,
  icon,
  testId,
  danger,
  children,
}: React.PropsWithChildren<DropZoneProps>) {
  const data: SideBarZoneData = { zone };
  const { setNodeRef, isOver } = useDroppable({
    id: `sidebar-zone-${zone}`,
    data,
  });

  return (
    <Zone
      ref={setNodeRef}
      data-testid={testId}
      $active={isOver}
      $danger={!!danger}
    >
      {icon}
      <span>{children}</span>
    </Zone>
  );
}

const ZoneBar = styled.div`
  position: fixed;
  left: 0;
  bottom: 0;
  z-index: ${p => p.theme.zIndex.sidebar + 4};
  box-sizing: border-box;
  display: flex;
  gap: 0.5rem;
  width: min(100vw, 20rem);
  padding: 0.75rem;
  padding-bottom: calc(0.75rem + env(safe-area-inset-bottom, 0px));
  background: ${p => p.theme.colors.bg};
  border-top: 1px solid ${p => p.theme.colors.bg2};
  box-shadow: ${p => p.theme.boxShadowSoft};
  /* Keep a finger on a zone from starting a scroll or text selection. */
  touch-action: none;
  user-select: none;
`;

const Zone = styled.div<{ $active: boolean; $danger: boolean }>`
  flex: 1;
  min-width: 0;
  min-height: 3.5rem;
  box-sizing: border-box;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 0.25rem;
  padding: 0.5rem;
  font-size: 0.85rem;
  border-radius: ${p => p.theme.radius};
  border: 2px dashed
    ${p => (p.$danger ? p.theme.colors.alert : p.theme.colors.main)};
  color: ${p => (p.$danger ? p.theme.colors.alert : p.theme.colors.main)};
  background: ${p => (p.$active ? p.theme.colors.bg2 : 'transparent')};
  transform: scale(${p => (p.$active ? 1.04 : 1)});
  ${transition('background', 'transform')}

  svg {
    font-size: 1.25rem;
  }
`;
