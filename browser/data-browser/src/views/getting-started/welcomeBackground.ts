import { css, keyframes } from 'styled-components';

const welcomeBgDrift = keyframes`
  0% {
    background-position: 0% 0%;
    transform: translate3d(0, 0, 0) scale(1);
  }
  100% {
    background-position: 100% 80%;
    transform: translate3d(0, 0, 0) scale(1.03);
  }
`;

export const welcomeBackgroundCss = css`
  position: relative;
  overflow: hidden;
  background: ${p => p.theme.colors.bgBody};

  /* Animated accent layer (pink + blue), behind content */
  &::before {
    content: '';
    position: absolute;
    inset: 0;
    pointer-events: none;
    opacity: ${p => (p.theme.darkMode ? 0.85 : 0.7)};
    background-image:
      radial-gradient(
        900px 520px at 78% 18%,
        rgba(255, 64, 192, ${p => (p.theme.darkMode ? 0.22 : 0.18)}),
        transparent 60%
      ),
      radial-gradient(
        1000px 520px at 22% 10%,
        rgba(0, 194, 255, ${p => (p.theme.darkMode ? 0.28 : 0.22)}),
        transparent 62%
      ),
      radial-gradient(
        960px 620px at 72% 92%,
        rgba(49, 120, 198, ${p => (p.theme.darkMode ? 0.2 : 0.18)}),
        transparent 60%
      );
    background-size: 120% 120%;
    background-position: 0% 0%;
    transform: translate3d(0, 0, 0);
    animation: ${welcomeBgDrift} 42s ease-in-out infinite alternate;
  }

  @media (prefers-reduced-motion: reduce) {
    &::before {
      animation: none;
    }
  }

  /* Ensure content sits above animated layer */
  & > * {
    position: relative;
    z-index: 1;
  }

  /* Base mesh gradients (slightly stronger, light/dark tuned) */
  ${p =>
    p.theme.darkMode
      ? css`
          background-image:
            linear-gradient(
              135deg,
              rgba(0, 194, 255, 0.12),
              transparent 45%,
              rgba(49, 120, 198, 0.12)
            ),
            radial-gradient(
              900px 420px at 20% 15%,
              rgba(0, 194, 255, 0.36),
              transparent 60%
            ),
            radial-gradient(
              800px 460px at 85% 25%,
              rgba(255, 255, 255, 0.09),
              transparent 62%
            ),
            radial-gradient(
              900px 520px at 50% 110%,
              rgba(0, 194, 255, 0.2),
              transparent 60%
            ),
            radial-gradient(
              720px 420px at 84% 86%,
              rgba(49, 120, 198, 0.26),
              transparent 60%
            );
        `
      : css`
          background-image:
            linear-gradient(
              135deg,
              rgba(0, 194, 255, 0.14),
              transparent 45%,
              rgba(49, 120, 198, 0.14)
            ),
            radial-gradient(
              900px 420px at 18% 15%,
              rgba(0, 194, 255, 0.3),
              transparent 60%
            ),
            radial-gradient(
              800px 460px at 85% 25%,
              rgba(0, 0, 0, 0.045),
              transparent 62%
            ),
            radial-gradient(
              900px 520px at 50% 110%,
              rgba(49, 120, 198, 0.24),
              transparent 60%
            ),
            radial-gradient(
              780px 420px at 82% 84%,
              rgba(0, 160, 120, 0.18),
              transparent 60%
            );
        `}
`;
