// @wc-ignore-file
import { styled } from 'styled-components';

/** Shared timing for docked layout changes and floating panel transitions. */
export const panelTransition = (dragging: boolean, ...properties: string[]) =>
  dragging
    ? 'none'
    : properties.map(property => `${property} 0.3s ease`).join(', ');

/** Keep the layout slot mounted so closing a panel also animates the content. */
export const PanelLayout = styled.div<{
  $width: string;
  $expanded: boolean;
  $dragging: boolean;
}>`
  position: relative;
  flex-shrink: 0;
  min-width: 0;
  width: ${p => (p.$expanded ? p.$width : '0px')};
  transition: ${p => panelTransition(p.$dragging, 'width')};
`;

/** Dims the page and closes a floating panel when clicked. */
export const PanelBackdrop = styled.div<{ $visible: boolean }>`
  position: fixed;
  inset: 0;
  z-index: ${p => p.theme.zIndex.sidebar - 1};
  cursor: pointer;
  transition: ${panelTransition(false, 'background-color')};
  background-color: ${p =>
    p.$visible ? 'rgba(0, 0, 0, 0.4)' : 'rgba(0, 0, 0, 0)'};
  pointer-events: ${p => (p.$visible ? 'auto' : 'none')};
  -webkit-tap-highlight-color: transparent;
`;
