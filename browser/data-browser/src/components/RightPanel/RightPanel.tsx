import React, { useRef } from 'react';
import { css, styled } from 'styled-components';
import {
  DragAreaBase,
  responsiveWidth,
  useResizable,
} from '@hooks/useResizable';
import { CSSVar } from '@helpers/CSSVar';
import { useMediaQuery } from '../../hooks/useMediaQuery';
import { useRightPanel } from './RightPanelContext';

const PANEL_WIDTH_PROP = new CSSVar('right-panel-width');

/**
 * Below this viewport width the panel floats OVER the content (a drawer with a
 * tap-out backdrop) instead of pushing it aside — otherwise on a portrait
 * tablet/phone it would leave the main content too little room.
 */
const PANEL_OVERLAY_BREAKPOINT = 1000;

/** The panel never takes the whole viewport: the content always keeps a strip
 *  (enough to see it and tap out of the drawer). */
const PANEL_WIDTH = `min(${PANEL_WIDTH_PROP.var()}, calc(100vw - 3rem))`;

interface RightPanelProps {
  isOpen: boolean;
  testId?: string;
}

/**
 * Resizable drawer docked to the right side. Shared by the AI sidebar, Comments
 * and meeting panels; pair with {@link useRightPanel} so only one is open at a
 * time. On wide screens it docks in the layout and pushes the content; on small
 * screens it floats over the content and closes on tap-out. Either way it
 * animates like the left sidebar (0.3s slide + fade).
 */
export const RightPanel: React.FC<React.PropsWithChildren<RightPanelProps>> = ({
  isOpen,
  testId,
  children,
}) => {
  const targetRef = useRef<HTMLDivElement>(null);
  const { activePanel, setPanelOpen } = useRightPanel();
  const wide = useMediaQuery(
    `(min-width: ${PANEL_OVERLAY_BREAKPOINT}px)`,
    true,
  );
  const overlay = !wide;

  const { size, dragAreaRef, isDragging, dragAreaListeners } = useResizable({
    edge: 'right',
    initialSize: responsiveWidth({ large: 480, laptop: 380 }),
    minSize: 280,
    maxSize: 2000,
    targetRef,
  });

  const close = () => {
    if (activePanel) {
      setPanelOpen(activePanel, false);
    }
  };

  return (
    <>
      {overlay && <Backdrop $visible={isOpen} onClick={close} aria-hidden />}
      <PanelContainer
        ref={targetRef}
        data-open={isOpen ? '' : undefined}
        $overlay={overlay}
        $dragging={isDragging}
        size={size}
        data-testid={testId}
      >
        <PanelDragArea
          ref={dragAreaRef}
          isDragging={isDragging}
          {...dragAreaListeners}
        />
        <PanelInner>{children}</PanelInner>
      </PanelContainer>
    </>
  );
};

interface PanelContainerProps {
  size: string;
  $overlay: boolean;
  $dragging: boolean;
}

const PanelContainer = styled.div.attrs<PanelContainerProps>(p => ({
  style: {
    [PANEL_WIDTH_PROP.raw]: p.size,
  } as Record<string, string>,
}))`
  ${p =>
    p.$overlay
      ? css`
          /* Drawer: floats over the content, slides in from the right. */
          position: absolute;
          top: 0;
          right: 0;
          bottom: 0;
          z-index: ${p.theme.zIndex.sidebar};
          width: ${PANEL_WIDTH};
          transform: translateX(100%);
          opacity: 0;
          box-shadow: ${p.theme.boxShadowIntense};
          transition: ${p.$dragging
            ? 'none'
            : 'transform 0.3s ease, opacity 0.3s ease'};

          &[data-open] {
            transform: translateX(0);
            opacity: 1;
          }
        `
      : css`
          /* Docked: part of the layout, grows to push the content aside. */
          position: relative;
          width: 0;
          min-width: 0;
          opacity: 0;
          overflow: hidden;
          transition: ${p.$dragging
            ? 'none'
            : 'width 0.3s ease, opacity 0.3s ease'};

          &[data-open] {
            width: ${PANEL_WIDTH};
            opacity: 1;
          }
        `}
`;

/**
 * Fixed to the panel's full width and pinned to the right edge, so the docked
 * container's width animation reveals it (via `overflow: hidden`) rather than
 * re-wrapping the content every frame.
 */
const PanelInner = styled.div`
  position: absolute;
  top: 0;
  right: 0;
  bottom: 0;
  width: ${PANEL_WIDTH};
  box-sizing: border-box;
  /* Grey backdrop: chat content renders directly on it (no inset box),
   * matching the full-page AI chat. */
  background-color: ${p => p.theme.colors.bgBody};
  border-left: 1px solid ${p => p.theme.colors.bg2};
  overflow: hidden;
  padding: ${p => p.theme.size()};
  padding-top: 2px;
`;

/** Dims the content and closes the drawer on tap (small screens only). */
const Backdrop = styled.div<{ $visible: boolean }>`
  position: fixed;
  inset: 0;
  z-index: ${p => p.theme.zIndex.sidebar - 1};
  cursor: pointer;
  transition: background-color 0.3s ease;
  background-color: ${p =>
    p.$visible ? 'rgba(0, 0, 0, 0.4)' : 'rgba(0, 0, 0, 0)'};
  pointer-events: ${p => (p.$visible ? 'auto' : 'none')};
  -webkit-tap-highlight-color: transparent;
`;

const PanelDragArea = styled(DragAreaBase)`
  --handle-margin: 1rem;
  height: calc(100% - var(--handle-margin) * 2);
  margin-top: var(--handle-margin);
  width: 12px;
  left: -6px;
  top: 0;
  bottom: 0;
  z-index: 1;
`;
