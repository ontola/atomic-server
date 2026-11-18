import { Suspense, lazy } from 'react';
import type { EmojiInputProps } from '../../chunks/EmojiInput/EmojiInput.js';
import { styled } from 'styled-components';

const EmojiInputAsync = lazy(
  () => import('../../chunks/EmojiInput/EmojiInput.js'),
);

export function EmojiInput(props: EmojiInputProps) {
  return (
    <Suspense fallback={<Fallback />}>
      <EmojiInputAsync {...props} />
    </Suspense>
  );
}

const Fallback = styled.span`
  display: inline-block;
  width: 2rem;
  height: 2rem;
`;
