import { uiTheme } from '../theme.js';
import { styled } from 'styled-components';

export const Gutter = styled.div`
  height: ${p => uiTheme(p.theme).margin}rem;
`;
