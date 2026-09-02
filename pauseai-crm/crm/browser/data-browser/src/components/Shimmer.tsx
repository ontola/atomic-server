import { PropsWithChildren } from 'react';
import { styled, keyframes } from 'styled-components';
import { transparentize } from 'polished';

const sweep = keyframes`
  from {
    transform: translateX(-100%);
  }

  to {
    transform: translateX(100%);
  }
`;

interface ShimmerProps {
  /** When false, children render without the shimmer overlay. */
  active?: boolean;
  className?: string;
}

/**
 * Wraps children with a sweeping highlight animation to indicate loading or
 * running processes. Children remain visible underneath.
 */
export function Shimmer({
  active = true,
  className,
  children,
}: PropsWithChildren<ShimmerProps>) {
  return (
    <Wrapper data-active={active} className={className}>
      {children}
    </Wrapper>
  );
}

const Wrapper = styled.span`
  position: relative;
  display: inline-block;
  overflow: hidden;
  isolation: isolate;
  border-radius: ${p => p.theme.radius};
  height: fit-content;
  &[data-active='true']::after {
    content: '';
    position: absolute;
    inset: 0;
    pointer-events: none;
    background: linear-gradient(
      90deg,
      transparent 0%,
      ${p =>
          p.theme.darkMode
            ? transparentize(0, p.theme.colors.bg)
            : transparentize(0.85, p.theme.colors.main)}
        45%,
      ${p =>
          p.theme.darkMode
            ? transparentize(0, p.theme.colors.bg)
            : transparentize(0.7, p.theme.colors.main)}
        50%,
      ${p =>
          p.theme.darkMode
            ? transparentize(0, p.theme.colors.bg)
            : transparentize(0.85, p.theme.colors.main)}
        55%,
      transparent 100%
    );
    animation: ${sweep} 1.5s ease-in-out infinite;
    @media (prefers-reduced-motion: reduce) {
      display: none;
    }
  }
`;
