import { styled } from 'styled-components';
import { transition } from '../../helpers/transition';

export const ToggleButton = styled.button<{ $active: boolean }>`
  display: flex;
  align-items: center;
  background-color: ${p => (p.$active ? 'var(--color-accent)' : 'transparent')};
  color: ${p => (p.$active ? 'white' : 'var(--color-text-subtle)')};
  appearance: none;
  border: none;
  border-radius: var(--radius-md);
  padding: 0.4rem;
  cursor: pointer;
  ${transition('background-color', 'color')};

  &:not(:disabled) {
    &:hover {
      background-color: ${p =>
        p.$active ? 'var(--color-accent-text)' : 'var(--color-border)'};
      color: ${p => (p.$active ? 'white' : 'var(--color-text)')};
    }
  }

  &:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
`;
