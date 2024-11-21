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
  border: 2px dashed ${p => p.theme.colors.bg2};
  border-radius: ${p => p.theme.radius};
  color: ${p => p.theme.colors.textLight};
  cursor: pointer;
  ${transition('background', 'color', 'border-color')}
  &:hover,
  &:focus-visible {
    background: ${p => p.theme.colors.bg};
    border-color: ${p => p.theme.colors.main};
    color: ${p => p.theme.colors.main};
  }
`;
