import {
  createGlobalStyle,
  DefaultTheme,
  ThemeProvider,
} from 'styled-components';
import { setLightness, setSaturation } from 'polished';
import './reset.css';
import { useContext, type JSX } from 'react';
import { SettingsContext } from './helpers/AppSettings';
import { CurrentBackgroundColor } from './globalCssVars';
import { buildTheme } from './styles/theme';
import {
  BREADCRUMB_BAR_TRANSITION_TAG,
  MEETING_PANEL_TITLE_TRANSITION_TAG,
  PAGE_TITLE_TRANSITION_TAG,
  RESOURCE_PAGE_TRANSITION_TAG,
} from './helpers/transitionName';

interface ThemeWrapperProps {
  children: React.ReactNode;
}

/**
 * Provides the theme for all components below. Make sure to wrap this inside
 * SettingsContext
 */
export const ThemeWrapper = ({ children }: ThemeWrapperProps): JSX.Element => {
  const { mainColor, darkMode, colorfulMode } = useContext(SettingsContext);

  return (
    <>
      <ThemeProvider theme={buildTheme(darkMode, mainColor, colorfulMode)}>
        {children}
      </ThemeProvider>
    </>
  );
};

export { presetColors } from './styles/presetColors';
export { animationDuration, zIndex } from './styles/theme';

/**
 * Wraps the app chrome (sidebar, navbar). In colorful mode it swaps the
 * neutral ramp for tones of the main color, so no grey ever sits on a colored
 * surface. Outside colorful mode it changes nothing.
 */
export const ChromeTheme = ({ children }: ThemeWrapperProps): JSX.Element => (
  <ThemeProvider theme={chromeTheme}>{children}</ThemeProvider>
);

const chromeTheme = (outer: DefaultTheme | undefined): DefaultTheme => {
  // ChromeTheme is always nested inside ThemeWrapper, so outer is never
  // actually undefined.
  if (!outer || !outer.colorful) {
    return outer!;
  }

  const tone = (lightness: number, saturation: number) =>
    setLightness(lightness, setSaturation(saturation, outer.colors.main));

  const colors = outer.darkMode
    ? {
        bg: tone(0.12, 0.35),
        bg1: tone(0.18, 0.35),
        bg2: tone(0.28, 0.3),
        text: tone(0.92, 0.3),
        text1: tone(0.85, 0.3),
        textLight: tone(0.72, 0.25),
        textLight2: tone(0.5, 0.25),
      }
    : {
        bg: tone(0.93, 0.55),
        bg1: tone(0.88, 0.5),
        bg2: tone(0.8, 0.4),
        text: tone(0.13, 0.4),
        text1: tone(0.18, 0.4),
        textLight: tone(0.35, 0.3),
        textLight2: tone(0.55, 0.25),
      };

  return { ...outer, colors: { ...outer.colors, ...colors } };
};

/** Adds basic styles for the entire app */
export const GlobalStyle = createGlobalStyle`

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
    scrollbar-color: ${p => p.theme.colors.bg2} transparent;
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
      background-color: ${p =>
        p.theme.colors.bg2}; /* color of the tracking area */
      border-radius: ${p => p.theme.radius};

      &:hover {
        background-color: ${p => p.theme.colors.borderStrong};
      }
    }
  }

  body {
    ${CurrentBackgroundColor.define(p => p.theme.colors.bgBody)}
    background-color: ${CurrentBackgroundColor.var()};
    color: ${props => props.theme.colors.text};
    font-family: ${props => props.theme.fontFamily};
    line-height: ${p => p.theme.lineHeight.base};
    word-wrap: break-word;
    overflow-wrap: anywhere;
    // Prevents weird scrollbars appearing for a split second when opening a dialog
    overflow: hidden;

    margin: 0;
    /** Pretty dark mode transition */
    transition: background-color .2s ease, border-color .2s ease, color .2s ease;
    font-size: 1rem;
  }

  input, button, body {
    /* Don't overflow input elements */
    overflow-wrap: normal;
  }

  /* Links are accent-coloured *text*, so they take the accent step that is
     readable rather than the one meant to be filled. With the fill, a light
     main colour (the mustard preset, say) produced links at 2.2:1. */
  a {
    color: ${props => props.theme.colors.accentText};
  }

  h1 {
    font-size: ${p => p.theme.fontSize.xl3};
  }

  h2 {
    font-size: ${p => p.theme.fontSize.xl2};
  }

  h3 {
    font-size: ${p => p.theme.fontSize.xl};
  }

  h4 {
    font-size: ${p => p.theme.fontSize.lg};
  }

  h1,h2,h3,h4,h5,h6 {
    margin-bottom: ${props => props.theme.size()};
    font-weight: ${p => p.theme.fontWeight.bold};
    font-family: ${p => p.theme.fontFamilyHeader};
    line-height: ${p => p.theme.lineHeight.tight};
    margin-top: 0;
    word-break: break-word;
  }

  i {
    font-style: italic;
  }

  p {
    margin-top: 0;
    margin-bottom: ${props => props.theme.size()};
  }

  ul {
    margin-top: 0;
    margin-bottom: ${props => props.theme.size()};
    padding: 0;

    li {
      list-style-type: disc;
      margin-left: ${props => props.theme.size(7)};
      margin-bottom: ${props => props.theme.size(2)};
    }
  }

  b {
    font-weight: bold;
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
