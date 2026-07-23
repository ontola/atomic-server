import { styled } from 'styled-components';

export const SideBarHeader = styled('div')`
  margin-top: 0.5rem;
  margin-bottom: 0.5rem;
  /* Same horizontal inset as the tree rows ({@link SideBarDrive} ListWrapper) */
  padding-inline: ${props => props.theme.margin}rem;
  font-size: 1.4rem;
  font-weight: bold;
  display: flex;
  align-items: stretch;
  min-width: 0;
`;
