import {
  createGlobalStyle,
  DefaultTheme,
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
 * The theme object is a *facade* over the CSS custom properties in
 * `styles/tokens.css`: every value it carries is a `var(--token)` reference
 * rather than a colour. Two consequences worth knowing about:
 *
 * - It no longer depends on the main colour, so there are exactly two theme
 *   objects (light and dark) and changing the accent re-renders nothing. The
 *   old object was rebuilt on every settings change and invalidated the whole
 *   tree through context.
 * - Anything that wants to *compute* with a colour cannot, because it is
 *   holding the string `var(--color-bg)`. Use `color-mix()` (see
 *   `styles/withAlpha.ts`) or add a token; the polished helpers only work on
 *   colours that come from data, such as a user's tag colour.
 */
export const ThemeWrapper = ({ children }: ThemeWrapperProps): JSX.Element => {
  const { mainColor, darkMode, colorfulMode } = useContext(SettingsContext);

  // Layout effect, not effect: the ramp has to be on `:root` before the first
  // paint of a theme change, or the page flashes the previous accent.
  useLayoutEffect(() => {
    const root = document.documentElement;

    root.dataset.theme = darkMode ? 'dark' : 'light';
    applyAccentRamp(root, {
      mainColor,
      darkMode,
      colorful: colorfulMode,
    });
  }, [mainColor, darkMode, colorfulMode]);

  return (
    <ThemeProvider theme={darkMode ? darkTheme : lightTheme}>
      {children}
    </ThemeProvider>
  );
};

/**
 * Wraps the app chrome (sidebar, navbar). In colourful mode the chrome tokens
 * carry tones of the main colour, so no neutral ever sits on a coloured
 * surface; outside colourful mode they fall back to the neutral ramp and this
 * changes nothing. Either way the decision lives in `accentRamp.ts`, and this
 * only points the theme at the other set of variables.
 */
export const ChromeTheme = ({ children }: ThemeWrapperProps): JSX.Element => (
  <ThemeProvider theme={chromeTheme}>{children}</ThemeProvider>
);

const chromeTheme = (outer: DefaultTheme | undefined): DefaultTheme => {
  // ChromeTheme is always nested inside ThemeWrapper, so outer is never
  // actually undefined.
  const base = outer ?? lightTheme;

  return {
    ...base,
    colors: {
      ...base.colors,
      bg: 'var(--chrome-bg)',
      bg1: 'var(--chrome-bg-subtle)',
      bg2: 'var(--chrome-border)',
      text: 'var(--chrome-text)',
      text1: 'var(--chrome-text)',
      textLight: 'var(--chrome-text-subtle)',
      textLight2: 'var(--chrome-text-subtle)',
    },
  };
};

/**
 * Adjust the z-index order here. Watch out: do not use in styled-components,
 * prefer to use `theme.zIndex`
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

const breadCrumbBarHeight = '2.2rem';
const floatingSearchBarPadding = '4.2rem';

/**
 * The spacing scale, as a reference to the matching `--space-n` token.
 *
 * The indices are the ones this function has always used, so every existing
 * `size(4)` keeps its value; it now resolves through CSS instead of returning a
 * literal, which is what lets plain CSS reach the same scale.
 */
function size(index = 3): string {
  if (!Number.isInteger(index) || index < 1 || index > 15) {
    throw new Error(`Size index ${index} out of bounds`);
  }

  return `var(--space-${index})`;
}

size.raw = (multiplier: number) => `${multiplier}rem`;

/**
 * The theme, as a map onto the token layer.
 *
 * Only `darkMode` actually varies — every other member is a constant string.
 * It is still a styled-components theme because 415 files read it that way;
 * migrating those to `var(--token)` directly is the next slice, and each one
 * that moves can simply stop reading `p.theme`.
 */
export const buildTheme = (darkMode: boolean): DefaultTheme => ({
  darkMode,
  colorful: false,
  fontFamilyHeader: 'var(--font-family-heading)',
  fontFamily: 'var(--font-family)',
  boxShadow: 'var(--elevation-1)',
  boxShadowIntense: 'var(--elevation-3)',
  boxShadowSoft: 'var(--elevation-2)',
  containerWidth: 40,
  containerWidthWide: '900px',
  fontSizeBody: 1,
  fontSizeH1: 2,
  sideBarWidth: 15,
  margin: 1,
  radius: 'var(--radius-md)',
  heights: {
    breadCrumbBar: breadCrumbBarHeight,
    floatingSearchBarPadding: floatingSearchBarPadding,
    fullPage: `100%`,
  },
  size,
  colors: {
    main: 'var(--color-accent)',
    mainLight: 'var(--color-accent-hover)',
    // Every remaining call site uses this as accent-coloured *text*, which is
    // a different requirement from the fill — see `--color-accent-text`.
    mainDark: 'var(--color-accent-text)',
    complementary: 'var(--accent-complementary)',
    bg: 'var(--color-bg)',
    bgBody: 'var(--color-bg-body)',
    mainSelectedBg: 'var(--color-accent-subtle)',
    mainSelectedFg: 'var(--color-accent-text)',
    bg1: 'var(--color-bg-subtle)',
    bg2: 'var(--color-border)',
    text: 'var(--color-text)',
    text1: 'var(--color-text)',
    textLight: 'var(--color-text-subtle)',
    textLight2: 'var(--color-text-subtle)',
    alert: 'var(--color-alert)',
    alertLight: 'var(--color-alert-subtle)',
    warning: 'var(--color-warning)',
    diff: {
      addedBg: 'var(--color-diff-added-bg)',
      addedFg: 'var(--color-diff-added-text)',
      removedBg: 'var(--color-diff-removed-bg)',
      removedFg: 'var(--color-diff-removed-text)',
    },
  },
  animation: {
    duration: 'var(--duration-fast)',
  },
  zIndex,
});

const lightTheme = buildTheme(false);
const darkTheme = buildTheme(true);

// Styled-components requires overwriting the default theme
declare module 'styled-components' {
  export interface DefaultTheme {
    /** If true, make things dark */
    darkMode: boolean;
    /**
     * @deprecated Colourful mode is a property of the chrome tokens now, not
     * of the theme object. Nothing reads this.
     */
    colorful: boolean;
    fontFamilyHeader: string;
    fontFamily: string;
    /** Body font size in rem */
    fontSizeBody: number;
    /** Header font size in rem */
    fontSizeH1: number;
    boxShadow: string;
    boxShadowIntense: string;
    boxShadowSoft: string;
    /**
     * @deprecated
     * use size() instead
     */
    margin: number;
    /** Width of the container, in rem */
    containerWidth: number;
    /** Width of the container */
    containerWidthWide: string;
    /** Width of the sidebar, in rem */
    sideBarWidth: number;
    /** Roundness of some elements / Border radius */
    radius: string;
    /** All theme colors */
    heights: {
      breadCrumbBar: string;
      fullPage: string;
      floatingSearchBarPadding: string;
    };

    /**
     * Function that returns a size in rem for the given index, as a reference
     * to the matching `--space-n` token.
     * Based on the following ratio:
     * 1) size.raw(0.25),
     * 2) size.raw(0.5),
     * 3) size.raw(1),
     * 4) size.raw(1.25),
     * 5) size.raw(1.5),
     * 6) size.raw(1.75),
     * 7) size.raw(2),
     * 8) size.raw(3),
     * 9) size.raw(4),
     * 10) size.raw(5),
     * 11) size.raw(7.5),
     * 12) size.raw(10),
     * 13) size.raw(15),
     * 14) size.raw(20),
     * 15) size.raw(30),
     *
     * When given no index it returns the default size (3)
     */
    size: typeof size;
    colors: {
      /** Main accent color, as a filled surface. Not readable as text — use
       * `mainDark` for that. */
      main: string;
      /** Hover state of a filled accent surface */
      mainLight: string;
      /** Accent color that is readable as text */
      mainDark: string;
      /** Background color of selected items */
      mainSelectedBg: string;
      /** Foreground color of selected items */
      mainSelectedFg: string;
      /** Complementary color of main */
      complementary: string;
      /** The background color of the body, which is subtly different from bg */
      bgBody: string;
      /** Most common background color: cards, dialogs, the navbar */
      bg: string;
      /** Subtle background color */
      bg1: string;
      /** Border color. Historically a third background step, used as a border
       * in 214 of its call sites. */
      bg2: string;
      /** Main (body) text color */
      text: string;
      /**
       * @deprecated Identical to `text`. Was a barely-different hue of it.
       */
      text1: string;
      /** Lighter shade of text, still readable */
      textLight: string;
      /**
       * @deprecated Use `textLight`. This used to be #ccc on white (1.6:1) —
       * the theme's own comment called it "not accessible for some" — and now
       * resolves to the same token as `textLight`.
       */
      textLight2: string;
      /** Error / warning color */
      alert: string;
      alertLight: string;
      warning: string;
      diff: {
        addedBg: string;
        addedFg: string;
        removedBg: string;
        removedFg: string;
      };
    };
    animation: {
      duration: string;
    };
    zIndex: typeof zIndex;
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
