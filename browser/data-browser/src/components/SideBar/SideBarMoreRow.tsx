import type { JSX } from 'react';
import { styled } from 'styled-components';
import { AtomicLink } from '../AtomicLink';
import { SideBarItem } from './SideBarItem';

/** Children the sidebar lists per folder; the rest are on the folder's page. */
export const SIDEBAR_CHILD_LIMIT = 50;

interface SideBarMoreRowProps {
  /** The folder whose page lists every child. */
  parent: string;
  hidden: number;
  onClick?: () => unknown;
}

/** Stands in for the children of a folder that the sidebar does not list. */
export function SideBarMoreRow({
  parent,
  hidden,
  onClick,
}: SideBarMoreRowProps): JSX.Element {
  return (
    <StyledLink subject={parent} clean data-testid='sidebar-more'>
      <MoreItem onClick={onClick}>{hidden} more, open to see all</MoreItem>
    </StyledLink>
  );
}

const StyledLink = styled(AtomicLink)`
  display: block;
  width: 100%;
`;

const MoreItem = styled(SideBarItem)`
  box-sizing: border-box;
  width: 100%;
  padding-left: 1.6rem;
  font-size: 0.85rem;
  font-style: italic;
`;
