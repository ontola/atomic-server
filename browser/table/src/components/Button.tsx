import { tableTheme } from '../theme.js';
import { css } from 'styled-components';
import { transition } from '../helpers/transition.js';

export const ghostButtonStyles = css`
  display: inline-flex;
  align-items: center;
  gap: 0.5ch;
  border: none;
  background-color: transparent;
  padding: 0.3rem 0.5rem;
  border-radius: ${p => tableTheme(p.theme).radius};
  color: ${p => tableTheme(p.theme).colors.textLight};
  font-size: 0.9rem;
  cursor: pointer;
  ${transition('background-color', 'color')};

  &:hover:not([disabled]),
  &:focus-visible:not([disabled]) {
    background-color: ${p => tableTheme(p.theme).colors.bg1};
    color: ${p => tableTheme(p.theme).colors.text};
  }

  &:disabled {
    cursor: default;
    opacity: 0.5;
  }
`;
