import { styled } from 'styled-components';

export interface SideBarItemProps {
  disabled?: boolean;
  current?: boolean;
}

/** SideBarItem should probably be wrapped in an AtomicLink for optimal behavior */
export const SideBarItem = styled('span')<SideBarItemProps>`
  box-sizing: border-box;
  display: flex;
  min-height: var(--space-5);
  align-items: center;
  justify-content: flex-start;
  color: ${p =>
    p.disabled ? 'var(--color-accent)' : 'var(--color-text-subtle)'};
  padding: 0.2rem;
  text-overflow: ellipsis;
  text-decoration: none;
  border-radius: var(--radius-md);
  overflow: hidden;
  &:hover,
  &:focus {
    background-color: var(--color-bg-subtle);
    // color: ${p =>
      p.disabled ? 'var(--color-accent)' : 'var(--color-text)'};
  }
  &:active {
    background-color: var(--color-border);
  }

  ${props =>
    props.current &&
    `
    color: var(--color-accent);
  `}

  svg {
    font-size: 0.8rem;
  }
`;
