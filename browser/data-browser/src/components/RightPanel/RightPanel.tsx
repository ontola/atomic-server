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
import { PanelBackdrop, PanelLayout, panelTransition } from '../PanelLayout';

const PANEL_WIDTH_PROP = new CSSVar('right-panel-width');

/**
 * Below this viewport width the panel floats OVER the content (a drawer with a
 * tap-out backdrop) instead of pushing it aside — otherwise on a portrait
 * tablet/phone it would leave the main content too little room.
 */
const PANEL_OVERLAY_BREAKPOINT = 1000;

/** Default width leaves a strip of content for tapping out of the drawer.
 *  AI chat opts into full width on phones, with an explicit close button. */
const PANEL_WIDTH = `min(${PANEL_WIDTH_PROP.var()}, calc(100vw - 3rem))`;

interface RightPanelProps {
  isOpen: boolean;
  testId?: string;
  fullWidthOnMobile?: boolean;
}

/**
 * Resizable drawer docked to the right side. Shared by the AI sidebar, Comments
 * and meeting panels; pair with {@link useRightPanel} so only one is open at a
 * time. On wide screens it docks in the layout and pushes the content; on small
 * screens it floats over the content and closes on tap-out. Either way it
 * shares its layout animation and timing with the left sidebar.
 */
export const RightPanel: React.FC<React.PropsWithChildren<RightPanelProps>> = ({
  isOpen,
  testId,
  fullWidthOnMobile = false,
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
      {overlay && (
        <PanelBackdrop $visible={isOpen} onClick={close} aria-hidden />
      )}
      <PanelContainer
        ref={targetRef}
        data-open={isOpen ? '' : undefined}
        $fullWidthOnMobile={fullWidthOnMobile}
        $overlay={overlay}
        $dragging={isDragging}
        $expanded={isOpen}
        $width={PANEL_WIDTH}
        size={size}
        data-testid={testId}
      >
        <PanelDragArea
          $fullWidthOnMobile={fullWidthOnMobile}
          ref={dragAreaRef}
          isDragging={isDragging}
          {...dragAreaListeners}
        />
        <PanelInner $fullWidthOnMobile={fullWidthOnMobile}>
          {children}
        </PanelInner>
      </PanelContainer>
    </>
  );
};

interface PanelContainerProps {
  size: string;
  $fullWidthOnMobile: boolean;
  $overlay: boolean;
}

const PanelContainer = styled(PanelLayout).attrs<PanelContainerProps>(p => ({
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
          transition: ${panelTransition(p.$dragging, 'transform', 'opacity')};

          &[data-open] {
            transform: translateX(0);
            opacity: 1;
          }
        `
      : css`
          /* Docked: part of the layout, grows to push the content aside. */
          opacity: 0;
          overflow: hidden;
          transition: ${panelTransition(p.$dragging, 'width', 'opacity')};

          &[data-open] {
            opacity: 1;
          }
        `}

  @media (max-width: 600px) {
    ${p =>
      p.$fullWidthOnMobile &&
      css`
        width: 100%;
      `}
  }
`;

/**
 * Fixed to the panel's full width and pinned to the right edge, so the docked
 * container's width animation reveals it (via `overflow: hidden`) rather than
 * re-wrapping the content every frame.
 */
const PanelInner = styled.div<{ $fullWidthOnMobile: boolean }>`
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

  @media (max-width: 600px) {
    ${p =>
      p.$fullWidthOnMobile &&
      css`
        width: 100%;
        border-left: none;
        padding: 0.25rem;
      `}
  }
`;

const PanelDragArea = styled(DragAreaBase)<{ $fullWidthOnMobile: boolean }>`
  @media (max-width: 600px) {
    ${p =>
      p.$fullWidthOnMobile &&
      css`
        display: none;
      `}
  }
  --handle-margin: 1rem;
  height: calc(100% - var(--handle-margin) * 2);
  margin-top: var(--handle-margin);
  width: 12px;
  left: -6px;
  top: 0;
  bottom: 0;
  z-index: 1;
`;
