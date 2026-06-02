import { styled } from 'styled-components';

interface SpinnerProps {
  size?: string;
  inheritColor?: boolean;
}

export const Spinner = ({ size, inheritColor = false }: SpinnerProps) => (
  <StyledSpinner size={size} inheritColor={inheritColor} viewBox='0 0 50 50'>
    <circle
      className='path'
      cx='25'
      cy='25'
      r='20'
      fill='none'
      strokeWidth='4'
    />
  </StyledSpinner>
);

const StyledSpinner = styled.svg<{ size?: string; inheritColor?: boolean }>`
  --spinner-size: ${props => props.size || '50px'};
  animation: rotate 2s linear infinite;
  width: var(--spinner-size);
  height: var(--spinner-size);
  max-width: 100%;
  max-height: 100%;

  & .path {
    stroke: ${props =>
      props.inheritColor ? 'currentColor' : props.theme.colors.main};
    stroke-linecap: round;
    animation: dash 1.5s ease-in-out infinite;
  }

  @keyframes rotate {
    100% {
      transform: rotate(360deg);
    }
  }
  @keyframes dash {
    0% {
      stroke-dasharray: 1, 150;
      stroke-dashoffset: 0;
    }
    50% {
      stroke-dasharray: 90, 150;
      stroke-dashoffset: -35;
    }
    100% {
      stroke-dasharray: 90, 150;
      stroke-dashoffset: -124;
    }
  }
`;
