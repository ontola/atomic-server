import { styled, keyframes } from 'styled-components';
import { CurrentBackgroundColor } from '../globalCssVars';

const loadingAnimation = keyframes`
  from {
    background-color: var(--loader-bg-from);
  }
  to {
    background-color: var(--loader-bg-to);
  }
`;

export const LoaderInline = styled.span`
  --loader-bg-from: ${p => p.theme.colors.bg1};
  --loader-bg-to: ${CurrentBackgroundColor.var()};
  background-color: ${p => p.theme.colors.bg1};
  border-radius: ${p => p.theme.radius};
  animation: ${loadingAnimation} 0.8s infinite ease-in-out alternate;
  flex: 1;
  display: inline-block;
  padding: 0;
  padding-inline: 1ch;
  margin: 0;
  color: ${p => p.theme.colors.textLight};
`;

export const LoaderBlock = styled.div`
  --loader-bg-from: ${p => p.theme.colors.bg1};
  --loader-bg-to: ${p => p.theme.colors.bg};
  background-color: ${p => p.theme.colors.bg1};
  border-radius: ${p => p.theme.radius};
  animation: ${loadingAnimation} 0.8s infinite ease-in-out alternate;
  width: 100%;
  height: 100%;
`;
