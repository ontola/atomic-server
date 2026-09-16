import { styled, css } from 'styled-components';

/**
 * Shared summary row for collapsible assistant-message parts (tool calls,
 * reasoning): icon + label in small light text. `$interactive` adds the grey
 * backdrop on hover for rows that expand on click; omit it for non-clickable
 * rows (e.g. while streaming).
 */
export const PartSummary = styled.div<{ $interactive?: boolean }>`
  display: flex;
  align-items: center;
  gap: 0.5ch;
  padding: 0.5em;
  border-radius: var(--radius-md);
  font-size: 0.7rem;
  width: fit-content;
  color: var(--color-text-subtle);
  transition: background-color var(--duration-fast) ease-out;

  ${p =>
    p.$interactive
      ? css`
          &:hover,
          &:focus-visible {
            background-color: var(--color-bg-subtle);
          }
        `
      : ''}

  & svg {
    flex-basis: 1em;
    min-width: 1em;
  }
`;
