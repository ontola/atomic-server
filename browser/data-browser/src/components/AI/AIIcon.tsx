import type { IconType } from 'react-icons';
import { styled } from 'styled-components';

export const AIIcon: IconType = ({ color }) => {
  return (
    <BWIconWrapper
      color={color}
      xmlns='http://www.w3.org/2000/svg'
      xmlSpace='preserve'
      strokeMiterlimit='10'
      style={{
        fillRule: 'nonzero',
        clipRule: 'evenodd',
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        fill: 'currentColor',
      }}
      viewBox='0 0 512 512'
    >
      <path d='m305 20-4 3-19 92-19 97-7 8-62 19-64 13c-2 1-3 2-3 4s1 3 3 4l64 13 62 19 7 8 19 97 19 92 4 3c2 0 4-1 4-3l20-92 19-97 6-8 63-19 64-13 2-4-2-4-64-13-63-19-6-8-19-97-20-92c0-2-2-3-4-3ZM91 55l-1 1-7 32-7 32-2 3-22 7-23 7v2l23 7 22 7 2 3 7 32 7 32 1 1 2-1 7-32 6-32 3-3 22-7 22-7 1-1-1-1-22-7-22-7-3-3v-1l-6-31-7-32-2-1ZM154 307l-1 1-8 35-7 34-2 2-23 7-24 8-1 1 1 2 24 7 23 7 2 3 7 33 8 35 1 1 2-1 7-35 7-33 2-3 24-7 23-7 1-2-1-1-23-8-24-7-2-2v-2l-7-32-7-35-2-1Z' />
    </BWIconWrapper>
  );
};

const BWIconWrapper = styled.svg<{ color?: string }>`
  color: ${p => p.color || 'inherit'};
  width: 1em;
  height: 1em;
  fill-rule: nonzero;
  clip-rule: evenodd;
  stroke-linecap: round;
  stroke-linejoin: round;
  fill: currentColor;
`;
