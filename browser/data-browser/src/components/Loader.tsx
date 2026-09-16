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
  --loader-bg-from: var(--color-bg-subtle);
  --loader-bg-to: ${CurrentBackgroundColor.var()};
  background-color: var(--color-bg-subtle);
  border-radius: var(--radius-md);
  animation: ${loadingAnimation} 0.8s infinite ease-in-out alternate;
  flex: 1;
  display: inline-block;
  padding: 0;
  padding-inline: 1ch;
  margin: 0;
  color: var(--color-text-subtle);
`;

export const LoaderBlock = styled.div`
  --loader-bg-from: var(--color-bg-subtle);
  --loader-bg-to: var(--color-bg);
  background-color: var(--color-bg-subtle);
  border-radius: var(--radius-md);
  animation: ${loadingAnimation} 0.8s infinite ease-in-out alternate;
  width: 100%;
  height: 100%;
`;
