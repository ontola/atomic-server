import { styled } from 'styled-components';

export const SideBarHeader = styled('div')`
  margin-top: 0.5rem;
  margin-bottom: 0.5rem;
  padding-inline: 0 ${props => props.theme.margin}rem;
  font-size: 1.4rem;
  font-weight: bold;
  display: flex;
  align-items: center;
`;
