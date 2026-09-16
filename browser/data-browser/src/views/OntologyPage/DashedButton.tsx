import { styled } from 'styled-components';
import { transition } from '../../helpers/transition';

export const DashedButton = styled.button<{ buttonHeight?: string }>`
  width: 100%;
  height: ${p => p.buttonHeight ?? '20rem'};
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 1ch;
  appearance: none;
  background: none;
  border: 1px dashed var(--color-border);
  border-radius: var(--radius-md);
  color: var(--color-text-subtle);
  cursor: pointer;
  ${transition('background', 'color', 'border-color', 'border-style')}
  &:hover,
  &:focus-visible {
    background: var(--color-bg);
    border-color: var(--color-accent);
    color: var(--color-accent);
    border-style: solid;
  }
`;
