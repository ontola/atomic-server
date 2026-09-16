import {
  createGlobalStyle,
  type DefaultTheme,
  ThemeProvider,
} from 'styled-components';
import './reset.css';
import './styles/tokens.css';
import { useContext, useLayoutEffect, type JSX } from 'react';
import { SettingsContext } from './helpers/AppSettings';
import { CurrentBackgroundColor } from './globalCssVars';
import { applyAccentRamp } from './styles/accentRamp';
import {
  BREADCRUMB_BAR_TRANSITION_TAG,
  MEETING_PANEL_TITLE_TRANSITION_TAG,
  PAGE_TITLE_TRANSITION_TAG,
  RESOURCE_PAGE_TRANSITION_TAG,
} from './helpers/transitionName';

export { presetColors } from './styles/presetColors';

interface ThemeWrapperProps {
  children: React.ReactNode;
}

/**
 * Provides the theme for all components below. Make sure to wrap this inside
 * SettingsContext.
 *
 * The theme carries one thing: whether dark mode is on. Every design value
 * lives in `styles/tokens.css` and is read from CSS directly, so this context
 * changing no longer means the tree restyles — and a main-colour change does
 * not touch React at all. It writes custom properties onto `:root` and the
 * cascade does the rest.
 */
export const ThemeWrapper = ({ children }: ThemeWrapperProps): JSX.Element => {
  const { mainColor, darkMode, colorfulMode } = useContext(SettingsContext);

  // Layout effect, not effect: the ramp has to be on `:root` before the first
  // paint of a theme change, or the page flashes the previous accent.
  useLayoutEffect(() => {
    const root = document.documentElement;

    root.dataset.theme = darkMode ? 'dark' : 'light';
    applyAccentRamp(root, { mainColor, darkMode, colorful: colorfulMode });
  }, [mainColor, darkMode, colorfulMode]);

  return (
    <ThemeProvider theme={darkMode ? darkTheme : lightTheme}>
      {children}
    </ThemeProvider>
  );
};

/**
 * The class the app chrome (navbar, sidebar) puts on itself to re-point the
 * surface tokens at the chrome ramp — see `.chrome-scope` in `tokens.css`.
 *
 * This was a nested `ThemeProvider` wrapping each of them. As a cascade scope
 * it needs no context and no wrapper element, and it nests correctly with
 * anything else that scopes a token.
 */
export const CHROME_SCOPE = 'chrome-scope';

/**
 * Adjust the z-index order here. The values live in `tokens.css` as `--z-*`;
 * this mirrors them for the rare consumer that needs the number in JS (the
 * toast library takes one as a prop).
 */
export const zIndex = {
  sidebar: 10,
  searchOverlay: 9,
  dialog: 100,
  dropdown: 200,
  networkIndicator: 300,
  toast: 400,
};

/** Default animation duration in ms. Mirrors `--duration-fast`. */
export const animationDuration = 100;

const lightTheme: DefaultTheme = { darkMode: false };
const darkTheme: DefaultTheme = { darkMode: true };

// Styled-components requires overwriting the default theme.
declare module 'styled-components' {
  export interface DefaultTheme {
    /**
     * Whether dark mode is on.
     *
     * The only thing left on the theme. It is here rather than in CSS because
     * roughly thirty components pass it to something that is not CSS — a
     * CodeMirror theme object, emoji-mart's `theme` prop, ReactFlow. Anything
     * that ends up as a style belongs in `styles/tokens.css` instead.
     */
    darkMode: boolean;
  }
}

/**
 * Adds basic styles for the entire app.
 *
 * Explicitly generic over `object`: with the colours now coming from tokens
 * there are no function interpolations left for styled-components to infer the
 * props from, and its fallback inference makes `theme` a *required* prop.
 */
export const GlobalStyle = createGlobalStyle<object>`

  :root {
    --view-transition-duration: 150ms;
  }

  /* Firefox 144 sizes the root view-transition snapshot from :root's
     used height. Without an explicit height the snapshot stretches
     (https://bugzilla.mozilla.org/show_bug.cgi?id=1962617). */
  html {
    height: 100%;
  }

  * {
    box-sizing: border-box;
    scrollbar-color: var(--color-border) transparent;
    @media print {
      scrollbar-color: transparent transparent;
    }
    &::-webkit-scrollbar {
      width: 10px;
      height: 10px;
      padding: 3px;
      background-color: transparent;/* color of the tracking area */

    }
    &::-webkit-scrollbar-thumb {
      width: 8px;
      margin: auto;
      background-color: var(--color-border); /* color of the tracking area */
      border-radius: var(--radius-md);

      &:hover {
        background-color: var(--color-border-strong);
      }
    }
  }

  body {
    ${CurrentBackgroundColor.define('var(--color-bg-body)')}
    background-color: ${CurrentBackgroundColor.var()};
    color: var(--color-text);
    font-family: var(--font-family);
    line-height: var(--line-height-base);
    word-wrap: break-word;
    overflow-wrap: anywhere;
    // Prevents weird scrollbars appearing for a split second when opening a dialog
    overflow: hidden;

    margin: 0;
    /** Pretty dark mode transition */
    transition: background-color .2s ease, border-color .2s ease, color .2s ease;
    font-size: var(--font-size-base);
  }

  input, button, body {
    /* Don't overflow input elements */
    overflow-wrap: normal;
  }

  /* Links are accent-coloured *text*, so they use the accent step that is
     readable rather than the one meant to be filled. With the fill, a light
     main colour (the mustard preset, say) produced links at 2.2:1. */
  a {
    color: var(--color-accent-text);
  }

  h1 {
    font-size: var(--font-size-3xl);
  }

  h2 {
    font-size: var(--font-size-2xl);
  }

  h3 {
    font-size: var(--font-size-xl);
  }

  h4 {
    font-size: var(--font-size-lg);
  }

  h1,h2,h3,h4,h5,h6 {
    margin-bottom: var(--space-3);
    font-weight: var(--font-weight-bold);
    font-family: var(--font-family-heading);
    line-height: var(--line-height-tight);
    margin-top: 0;
    word-break: break-word;
  }

  i {
    font-style: italic;
  }

  p {
    margin-top: 0;
    margin-bottom: var(--space-3);
  }

  ul {
    margin-top: 0;
    margin-bottom: var(--space-3);
    padding: 0;

    li {
      list-style-type: disc;
      margin-left: var(--space-7);
      margin-bottom: var(--space-2);
    }
  }

  b {
    font-weight: var(--font-weight-bold);
  }

  /* —— View transitions ——
     Matched pairs (same view-transition-name on both pages, e.g. a grid
     item's title morphing into the page H1) get the UA's plus-lighter
     cross-fade, which is seamless where pixels are identical. */
  ::view-transition-old(*),
  ::view-transition-new(*) {
    animation-duration: var(--view-transition-duration);
  }

  /* Title morphs: scale by height so a narrow grid label does not smear
     horizontally into the page H1. Firefox does not interpolate changing
     aspect ratios as smoothly as Chromium — scoped to titles via
     view-transition-class so it does not apply to card→page morphs. */
  ::view-transition-old(.${PAGE_TITLE_TRANSITION_TAG}),
  ::view-transition-new(.${PAGE_TITLE_TRANSITION_TAG}),
  ::view-transition-old(.${MEETING_PANEL_TITLE_TRANSITION_TAG}),
  ::view-transition-new(.${MEETING_PANEL_TITLE_TRANSITION_TAG}) {
    block-size: 100%;
    inline-size: auto;
  }

  /* Card / main morphs: fill the animating group on both axes. Scaling by
     height alone made a square card snapshot as wide as the page is tall —
     a giant overlay, worst on Firefox. */
  ::view-transition-old(.${RESOURCE_PAGE_TRANSITION_TAG}),
  ::view-transition-new(.${RESOURCE_PAGE_TRANSITION_TAG}) {
    inline-size: 100%;
    block-size: 100%;
    object-fit: cover;
    overflow: clip;
  }

  /* Keep geometry (group) animations on the same clock as the fades. The UA
     default is 250ms, which held the snapshot overlay up ~100ms after the
     150ms fades had already finished. */
  ::view-transition-group(*) {
    animation-duration: var(--view-transition-duration);
  }

  /* A snapshot with no counterpart on the other page (old- or new-only —
     every group during a sidebar navigation) must swap instantly. Letting
     it alpha-fade dims unchanged-looking content ~25% mid-fade, which reads
     as a full-page flash. Morphing pairs are unaffected (their image-pair
     has two children). The download-button rules below intentionally
     override this to keep their slide in/out. */
  ::view-transition-old(*):only-child,
  ::view-transition-new(*):only-child {
    animation-duration: 0ms;
  }

  ::view-transition-old(root),
  ::view-transition-new(root) {
    animation-duration: 0ms;
  }

  @keyframes slide-in-from-right {
    from {
      transform: translateX(5rem);
      opacity: 0;
    }

    to {
      transform: translateX(0);
      opacity: 1;
    }
  }

  ::view-transition-image-pair(download-button) {
    mix-blend-mode: normal;
  }

  ::view-transition-old(download-button):only-child,
  ::view-transition-new(download-button):only-child {
    animation: slide-in-from-right var(--view-transition-duration) ease-in-out;
    animation-fill-mode: both;
  }

  ::view-transition-old(download-button):only-child {
    animation-direction: reverse;
  }

  /* Keep the navigation bar above the morphing page groups. */
  ::view-transition-group(${BREADCRUMB_BAR_TRANSITION_TAG}) {
    z-index: 10;
  }

  @media (prefers-reduced-motion) {
  ::view-transition-group(*),
  ::view-transition-old(*),
  ::view-transition-new(*) {
    animation: none !important;
  }
}

  @keyframes toast-enter {
    0%   {left:110%;}
    100% {left:0;}
  }

  @keyframes toast-exit {
    0%   {left:0;}
    100% {left:110%;}
  }
`;
