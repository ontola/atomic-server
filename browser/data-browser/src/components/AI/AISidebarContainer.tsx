import React, { Suspense, useRef } from 'react';
import { styled } from 'styled-components';
import { useAISidebar } from './AISidebarContext';
import { ChatLoadingIndicator } from './ChatLoadingIndicator';
import { DragAreaBase, useResizable } from '@hooks/useResizable';
import { AI_SIDEBAR_WIDTH_PROP } from './AISidebarCSSVars';

const AISidebar = React.lazy(() => import('@chunks/AI/AISidebar'));

export const AISidebarContainer: React.FC = () => {
  const { isOpen } = useAISidebar();
  const targetRef = useRef<HTMLDivElement>(null);

  const { size, dragAreaRef, isDragging, dragAreaListeners } = useResizable({
    edge: 'right',
    initialSize: 480,
    minSize: 280,
    maxSize: 2000,
    targetRef,
  });

  return (
    <SidebarContainer
      ref={targetRef}
      data-open={isOpen ? '' : undefined}
      size={size}
      data-testid='ai-sidebar'
    >
      <AISidebarDragArea
        ref={dragAreaRef}
        isDragging={isDragging}
        {...dragAreaListeners}
      />
      <Suspense fallback={<ChatLoadingIndicator />}>
        {isOpen && <AISidebar />}
      </Suspense>
    </SidebarContainer>
  );
};

interface SidebarContainerProps {
  size: string;
}

const SidebarContainer = styled.div.attrs<SidebarContainerProps>(p => ({
  style: {
    [AI_SIDEBAR_WIDTH_PROP.raw]: p.size,
  } as Record<string, string>,
}))`
  position: relative;
  background-color: ${p => p.theme.colors.bg};
  display: none;
  transform: translateX(${AI_SIDEBAR_WIDTH_PROP.var()});
  width: min(${AI_SIDEBAR_WIDTH_PROP.var()}, 100vw);
  overflow: hidden;
  border-left: 1px solid ${p => p.theme.colors.bg2};
  padding: ${p => p.theme.size()};
  padding-top: 2px;
  transition:
    display 100ms allow-discrete,
    transform 100ms ease-in-out;

  &[data-open] {
    transform: translateX(0rem);
    display: block;
  }

  @starting-style {
    transform: translateX(${AI_SIDEBAR_WIDTH_PROP.var()});
    display: none;
  }
`;

const AISidebarDragArea = styled(DragAreaBase)`
  --handle-margin: 1rem;
  height: calc(100% - var(--handle-margin) * 2);
  margin-top: var(--handle-margin);
  width: 12px;
  left: -6px;
  top: 0;
  bottom: 0;
`;
