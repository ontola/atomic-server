import { styled } from 'styled-components';
import { SB_BOTTOM_RADIUS, SB_HIGHLIGHT, SB_TOP_RADIUS } from './searchboxVars';

export const SearchBoxButton = styled.button<{ ephimeral?: boolean }>`
  background-color: transparent;
  border: none;
  border-left: ${p => (p.ephimeral ? 'none' : '1px solid var(--color-border)')};
  display: flex;
  align-items: center;
  padding: 0.5rem;
  color: var(--color-text-subtle);
  cursor: pointer;
  visibility: ${p => (p.ephimeral ? 'hidden' : 'visible')};

  &:last-child {
    border-top-right-radius: ${SB_TOP_RADIUS.var('var(--radius-md)')};
    border-bottom-right-radius: ${SB_BOTTOM_RADIUS.var('var(--radius-md)')};
  }

  &:disabled {
    color: var(--color-text-subtle);
    cursor: not-allowed;
  }

  &:not(:disabled) {
    &:hover,
    &:focus-visible {
      color: ${SB_HIGHLIGHT.var()};
      background-color: var(--color-bg-subtle);
      border-color: ${SB_HIGHLIGHT.var()};
    }
  }

  div:hover > & {
    visibility: visible;
  }
`;
