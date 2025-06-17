import { styled } from 'styled-components';
import { Collapse } from '../Collapse';
import { useState, type JSX } from 'react';

export interface SideBarPanelProps {
  title: string;
  /** When false, section starts collapsed */
  defaultOpen?: boolean;
  /** Tighter padding when nested inside the drive tree (e.g. Shared with me) */
  embedded?: boolean;
  'data-testid'?: string;
}

export function SideBarPanel({
  children,
  title,
  defaultOpen = true,
  embedded = false,
  'data-testid': dataTestId,
}: React.PropsWithChildren<SideBarPanelProps>): JSX.Element {
  const [open, setOpen] = useState(defaultOpen);

  return (
    <Wrapper $embedded={embedded} data-testid={dataTestId}>
      <HeaderButton
        type='button'
        onClick={() => setOpen(prev => !prev)}
        aria-expanded={open}
        aria-label={`${open ? 'Collapse' : 'Expand'} ${title}`}
      >
        <PanelTitle>{title}</PanelTitle>
      </HeaderButton>
      <StyledCollapse open={open} $embedded={embedded}>
        {children}
      </StyledCollapse>
    </Wrapper>
  );
}

const PanelTitle = styled.span`
  font-size: 0.75rem;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: ${p => p.theme.colors.textLight};
  text-align: start;
  white-space: nowrap;
`;

const HeaderButton = styled.button`
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
