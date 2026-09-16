import { PropsWithChildren } from 'react';
import { styled, keyframes } from 'styled-components';
import { withAlpha } from '../styles/withAlpha';

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
  border-radius: var(--radius-md);
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
            ? withAlpha('var(--color-bg)', 1)
            : withAlpha('var(--color-accent)', 0.15)}
        45%,
      ${p =>
          p.theme.darkMode
            ? withAlpha('var(--color-bg)', 1)
            : withAlpha('var(--color-accent)', 0.3)}
        50%,
      ${p =>
          p.theme.darkMode
            ? withAlpha('var(--color-bg)', 1)
            : withAlpha('var(--color-accent)', 0.15)}
        55%,
      transparent 100%
    );
    animation: ${sweep} 1.5s ease-in-out infinite;
    @media (prefers-reduced-motion: reduce) {
      display: none;
    }
  }
`;
