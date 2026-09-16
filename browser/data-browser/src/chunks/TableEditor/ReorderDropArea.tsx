import { useDroppable } from '@dnd-kit/core';

import { styled } from 'styled-components';
import { transition } from '@helpers/transition';
import { withAlpha } from '../../styles/withAlpha';

interface ReorderDropAreaProps {
  index: number;
}

export function ReorderDropArea({ index }: ReorderDropAreaProps) {
  const { setNodeRef, isOver } = useDroppable({
    id: `droppable-${index}`,
    data: { index },
  });

  return <ReorderDropZone ref={setNodeRef} hover={isOver} />;
}

const ReorderDropZone = styled.div<{ hover: boolean }>`
  --dropzone-width: 0.4rem;
  position: absolute;
  background-color: var(--color-accent);
  opacity: 0.4;
  width: var(--dropzone-width);
  height: min(
    var(--table-height),
    var(--table-content-height) + var(--table-row-height)
  );
  top: 0;
  left: calc(var(--dropzone-width) * 0.5 * -1);
  z-index: 10;
  box-shadow: 0 0 7px 0 ${withAlpha('var(--color-accent)', 0.7)};
  transform: scaleX(${p => (p.hover ? 1 : 0)});
  ${transition('transform', 'opacity')}
`;
