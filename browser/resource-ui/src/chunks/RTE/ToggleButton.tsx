import { resourceTheme } from '../../theme.js';
import { styled } from 'styled-components';
import { transition } from '@tomic/ui/helpers/transition';

export const ToggleButton = styled.button<{ $active: boolean }>`
  display: flex;
  align-items: center;
  background-color: ${p =>
    p.$active ? resourceTheme(p.theme).colors.main : 'transparent'};
  color: ${p =>
    p.$active ? 'white' : resourceTheme(p.theme).colors.textLight};
  appearance: none;
  border: none;
  border-radius: ${p => resourceTheme(p.theme).radius};
  padding: 0.4rem;
  cursor: pointer;
  ${transition('background-color', 'color')};

  &:not(:disabled) {
    &:hover {
      background-color: ${p =>
        p.$active
          ? resourceTheme(p.theme).colors.mainDark
          : resourceTheme(p.theme).colors.bg2};
      color: ${p => (p.$active ? 'white' : resourceTheme(p.theme).colors.text)};
    }
  }

  &:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
`;
