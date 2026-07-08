import React, { useRef } from 'react';
import { styled } from 'styled-components';
import {
  DragAreaBase,
  responsiveWidth,
  useResizable,
} from '@hooks/useResizable';
import { CSSVar } from '@helpers/CSSVar';

const PANEL_WIDTH_PROP = new CSSVar('right-panel-width');

interface RightPanelProps {
  isOpen: boolean;
  testId?: string;
}

/**
 * Resizable drawer docked to the right side of the screen. Shared by the AI
 * sidebar and the Comments panel; pair with {@link useRightPanel} so only one
 * is open at a time.
 */
export const RightPanel: React.FC<React.PropsWithChildren<RightPanelProps>> = ({
  isOpen,
  testId,
  children,
}) => {
  const targetRef = useRef<HTMLDivElement>(null);

  const { size, dragAreaRef, isDragging, dragAreaListeners } = useResizable({
    edge: 'right',
    initialSize: responsiveWidth({ large: 480, laptop: 380 }),
    minSize: 280,
    maxSize: 2000,
    targetRef,
  });

  return (
    <PanelContainer
      ref={targetRef}
      data-open={isOpen ? '' : undefined}
      size={size}
      data-testid={testId}
    >
      <PanelDragArea
        ref={dragAreaRef}
        isDragging={isDragging}
        {...dragAreaListeners}
      />
      {children}
    </PanelContainer>
  );
};

interface PanelContainerProps {
  size: string;
}

const PanelContainer = styled.div.attrs<PanelContainerProps>(p => ({
  style: {
    [PANEL_WIDTH_PROP.raw]: p.size,
  } as Record<string, string>,
}))`
  position: relative;
  /* Grey backdrop: chat content renders directly on it (no inset box),
   * matching the full-page AI chat. */
  background-color: ${p => p.theme.colors.bgBody};
  display: none;
  transform: translateX(${PANEL_WIDTH_PROP.var()});
  width: min(${PANEL_WIDTH_PROP.var()}, 100vw);
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
    transform: translateX(${PANEL_WIDTH_PROP.var()});
    display: none;
  }
`;

const PanelDragArea = styled(DragAreaBase)`
  --handle-margin: 1rem;
  height: calc(100% - var(--handle-margin) * 2);
  margin-top: var(--handle-margin);
  width: 12px;
  left: -6px;
  top: 0;
  bottom: 0;
`;
