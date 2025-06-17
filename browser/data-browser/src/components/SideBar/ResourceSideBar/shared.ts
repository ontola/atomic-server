import { styled } from 'styled-components';
import { AtomicLink } from '../../AtomicLink';

export const StyledLink = styled(AtomicLink)`
  box-sizing: border-box;
  flex: 1;
  min-width: 0;
  width: 100%;
  overflow: hidden;
  white-space: nowrap;
`;
export const TextWrapper = styled.span`
  display: flex;
  align-items: center;
  gap: 0.4rem;
  flex: 1;
  min-width: 0;
  width: 100%;
`;
