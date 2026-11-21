import { tableTheme } from '../../../theme.js';
import { styled } from 'styled-components';

export const InputBase = styled.input`
  position: absolute;
  border: none;
  inset: 0;
  padding-inline: var(--table-inner-padding);
  background-color: ${p => tableTheme(p.theme).colors.bg};
  color: ${p => tableTheme(p.theme).colors.text};
`;
