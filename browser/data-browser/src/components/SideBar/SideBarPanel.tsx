import { styled } from 'styled-components';
import { Collapse } from '../Collapse';
import { useRef, useState, type JSX } from 'react';
import { useResizable } from '@hooks/useResizable';
import { useLocalStorage } from '@hooks/useLocalStorage';

export interface SideBarPanelProps {
  title: string;
  /** Stable, untranslated key for the section's height preference. */
  heightStorageKey: string;
  initialHeight?: number;
  actions?: React.ReactNode;
  /** When false, section starts collapsed */
  defaultOpen?: boolean;
  /** Tighter padding when nested inside the drive tree (e.g. Shared with me) */
  embedded?: boolean;
  'data-testid'?: string;
}

export function SideBarPanel({
  children,
  title,
  heightStorageKey,
  initialHeight = 320,
  actions,
  defaultOpen = true,
  embedded = false,
  'data-testid': dataTestId,
}: React.PropsWithChildren<SideBarPanelProps>): JSX.Element {
  const [open, setOpen] = useState(defaultOpen);
  const contentRef = useRef<HTMLDivElement>(null);
  const [storedHeight, setStoredHeight] = useLocalStorage(
    heightStorageKey,
    initialHeight,
  );
  const { size, dragAreaListeners, isDragging } = useResizable({
    initialSize: storedHeight,
    minSize: 60,
    maxSize: 1200,
    targetRef: contentRef,
    edge: 'bottom',
    mode: 'delta',
    threshold: 6,
    onResize: setStoredHeight,
  });

  return (
    <Wrapper $embedded={embedded} data-testid={dataTestId}>
      <HeaderRow>
        <HeaderButton
          type='button'
          onClick={() => setOpen(prev => !prev)}
          aria-expanded={open}
          aria-label={`${open ? 'Collapse' : 'Expand'} ${title}`}
          title={open ? 'Drag to resize' : undefined}
          $dragging={isDragging}
          {...(open ? dragAreaListeners : {})}
        >
          <PanelTitle>{title}</PanelTitle>
        </HeaderButton>
        {actions}
      </HeaderRow>
      <StyledCollapse open={open} $embedded={embedded}>
        <PanelContent ref={contentRef} style={{ maxHeight: size }}>
          {children}
        </PanelContent>
      </StyledCollapse>
    </Wrapper>
  );
}

const HeaderRow = styled.div`
  display: flex;
  align-items: center;
  gap: 0.25rem;
`;

const PanelTitle = styled.span`
  font-size: 0.75rem;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: ${p => p.theme.colors.textLight};
  text-align: start;
  white-space: nowrap;
`;

const HeaderButton = styled.button<{ $dragging: boolean }>`
  background: none;
  border: none;
  margin: 0;
  padding: 0.35rem 0.5rem;
  display: flex;
  align-items: center;
  justify-content: flex-start;
  cursor: pointer;
  border-radius: ${p => p.theme.radius};
  box-sizing: border-box;
  width: 100%;
  text-align: start;
  gap: 0.5rem;

  &[aria-expanded='true'] {
    touch-action: none;
    user-select: none;
    cursor: row-resize;
  }

  &[aria-expanded='true']::after {
    content: '';
    margin-left: auto;
    flex-shrink: 0;
    width: 1.25rem;
    height: 3px;
    border-radius: 2px;
    background: ${p => p.theme.colors.textLight};
    opacity: ${p => (p.$dragging ? 1 : 0)};
  }

  &:hover::after,
  &:focus-visible::after {
    opacity: 1;
  }

  @media (pointer: coarse) {
    min-height: 44px;

    &[aria-expanded='true']::after {
      opacity: 0.5;
    }
  }

  &:hover {
    background-color: ${p => p.theme.colors.bg1};
  }

  &:hover ${PanelTitle} {
    color: ${p => p.theme.colors.text};
  }

  &:focus-visible {
    outline: 2px solid ${p => p.theme.colors.main};
    outline-offset: 2px;
  }
`;

const PanelContent = styled.div`
  overflow-y: auto;
  overscroll-behavior-y: contain;
`;

const StyledCollapse = styled(Collapse)<{ $embedded: boolean }>`
  box-sizing: border-box;
  width: 100%;
  min-width: 0;
  padding-inline: 0;
  padding-bottom: ${p => (p.$embedded ? '0.35rem' : '0')};
`;

const Wrapper = styled.div<{ $embedded: boolean }>`
  display: flex;
  flex-direction: column;
  align-items: stretch;
  width: 100%;
  max-width: 100%;
  min-width: 0;
  max-height: fit-content;
  box-sizing: border-box;

  ${p =>
    p.$embedded
      ? `
    margin-top: 0.5rem;
    padding-top: 0.25rem;
  `
      : ''}
`;
