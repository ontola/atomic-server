import { tableTheme } from '../theme.js';
import { css, type DefaultTheme } from 'styled-components';

export function transition(...properties: string[]) {
  const interpolate = (theme: DefaultTheme) =>
    properties
      .map(p => `${p} ${tableTheme(theme).animation.duration} ease-in-out`)
      .join(',');

  return css`
    transition: ${({ theme }) => interpolate(theme)};
  `;
}
