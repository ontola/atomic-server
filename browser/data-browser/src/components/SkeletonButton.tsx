import { styled } from 'styled-components';
import { transition } from '../helpers/transition';

export const SkeletonButton = styled.button`
  display: flex;
  justify-content: center;
  align-items: center;
  gap: var(--space-1);
  color: var(--color-text-subtle);
  background: none;
  appearance: none;
  border: 1px dashed var(--color-border);
  border-radius: var(--radius-md);

  cursor: pointer;
  ${transition('color', 'border')}

  & svg {
    ${transition('transform')}
  }
  &:hover,
  &:focus-visible {
    color: var(--color-accent);
    border: 1px solid var(--color-accent);

    & svg {
      transform: scale(1.3);
    }
  }

  &:active {
    background-color: var(--color-bg-subtle);
  }
`;
