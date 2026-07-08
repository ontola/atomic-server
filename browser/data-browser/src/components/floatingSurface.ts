import { css, keyframes } from 'styled-components';
import { transparentize } from 'polished';

/**
 * The one look for floating UI surfaces — dropdown menus and popovers share
 * this so they can't drift apart: frosted translucent background, soft
 * shadow, theme radius, and a border in dark mode (where shadows don't
 * read).
 *
 * Pair with {@link floatingSurfaceAppear} (mount-animation consumers) or an
 * equivalent `@starting-style` transition for the entrance.
 */
export const floatingSurface = css`
  background-color: ${p => transparentize(0.2, p.theme.colors.bgBody)};
  backdrop-filter: blur(10px);
  box-shadow: ${p => p.theme.boxShadowSoft};
  border-radius: ${p => p.theme.radius};
  border: ${p =>
    p.theme.darkMode ? `1px solid ${p.theme.colors.bg2}` : 'none'};

  @media (prefers-contrast: more) {
    border: 1px solid ${p => p.theme.colors.bg2};
    background-color: ${p => p.theme.colors.bg};
    backdrop-filter: none;
  }
`;

/** Quick fade + slight grow, the shared entrance for floating surfaces. */
export const floatingSurfaceAppear = keyframes`
  from {
    opacity: 0;
    scale: 0.95;
  }
  to {
    opacity: 1;
    scale: 1;
  }
`;
