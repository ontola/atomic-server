/**
 * The theme object: the palette and scales from `ramps.ts`, mapped onto the
 * names components read.
 *
 * Separate from `styling.tsx` because this is pure data. `styling.tsx` pulls in
 * `AppSettings` and therefore most of the app, which a test that only wants to
 * check contrast should not have to load.
 */

import type { DefaultTheme } from 'styled-components';
import {
  buildAccentRamp,
  diffColors,
  durations,
  easings,
  elevations,
  fontSizes,
  fontWeights,
  lineHeights,
  neutralRamp,
  radii,
  statusColors,
  type Ramp,
} from './ramps';
import { setLightness, setSaturation } from 'polished';
import { hexToRgb } from './oklch';
import { DEFAULT_MAIN_COLOR } from './presetColors';

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

/** Default animation duration in ms */
export const animationDuration = 100;

const breadCrumbBarHeight = '2.2rem';
const floatingSearchBarPadding = '4.2rem';

function size(index = 3): string {
  const sizes = [
    size.raw(0.25),
    size.raw(0.5),
    size.raw(1),
    size.raw(1.25),
    size.raw(1.5),
    size.raw(1.75),
    size.raw(2),
    size.raw(3),
    size.raw(4),
    size.raw(5),
    size.raw(7.5),
    size.raw(10),
    size.raw(15),
    size.raw(20),
    size.raw(30),
  ];

  const sizeStr = sizes[index - 1];

  if (sizeStr === undefined) {
    throw new Error(`Size index ${index} out of bounds`);
  }

  return sizeStr;
}

size.raw = (multiplier: number) => `${multiplier}rem`;

/**
 * Construct a StyledComponents theme object.
 *
 * The theme is still the single source every component reads, and it is still
 * typed — but it now carries the whole palette and the whole set of scales
 * rather than three greys and a radius. `styles/ramps.ts` decides the values;
 * this maps them onto the names components use.
 *
 * The semantic aliases (`bg`, `bg1`, `bg2`, `textLight`, `main`, …) all keep
 * their old names, so nothing had to change at the call sites. What changed is
 * what they point at, and that there is now somewhere to put a decision that
 * previously became a literal in a styled component.
 */
export const buildTheme = (
  darkMode: boolean,
  mainIn: string,
  colorful = false,
): DefaultTheme => {
  // A stored main colour can be missing (useLocalStorage cold start during HMR)
  // or unparseable (an older release wrote something else there). Both would
  // otherwise reach polished below, which throws rather than falling back.
  const safeMain = hexToRgb(mainIn ?? '') ? mainIn : DEFAULT_MAIN_COLOR;
  const neutral = neutralRamp(darkMode);
  const accent = buildAccentRamp(safeMain, darkMode);
  const status = statusColors(darkMode);
  const elevation = elevations(darkMode);

  // The surface cards, dialogs, the navbar and the sidebar sit on. White in
  // light mode; in dark mode a step above the body, which is the fix for
  // surfaces that used to be pure black on a pure black page and could only be
  // found by their border.
  const surface = darkMode ? neutral[1] : '#ffffff';
  // Colorful mode: content and text stay neutral for readability; the main
  // color shows in the app chrome (sidebar, navbar) via ChromeTheme, with a
  // barely-there tint on the body behind it. Tinting the full neutral ramp
  // reads as a monochrome wash, not as color.
  const bgBodyColorful = darkMode
    ? setLightness(0.045, setSaturation(0.25, safeMain))
    : setLightness(0.975, setSaturation(0.35, safeMain));

  return {
    darkMode,
    colorful,
    fontFamilyHeader:
      "'Montserrat', 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif",
    fontFamily:
      "'Open Sans', 'Helvetica Neue', 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif",
    boxShadow: elevation.low,
    boxShadowIntense: elevation.high,
    boxShadowSoft: elevation.medium,
    elevation,
    containerWidth: 40,
    containerWidthWide: '900px',
    fontSizeBody: 1,
    fontSizeH1: 2,
    fontSize: fontSizes,
    lineHeight: lineHeights,
    fontWeight: fontWeights,
    sideBarWidth: 15,
    margin: 1,
    radius: radii.md,
    radii,
    duration: durations,
    easing: easings,
    heights: {
      breadCrumbBar: breadCrumbBarHeight,
      floatingSearchBarPadding: floatingSearchBarPadding,
      fullPage: `100%`,
    },
    size,
    colors: {
      neutral,
      accent: accent.ramp,
      main: accent.ramp[8],
      mainLight: accent.ramp[9],
      // Every call site uses this as accent-coloured *text*, which is a
      // different requirement from the fill — see `accentText`.
      mainDark: accent.ramp[10],
      accentText: accent.ramp[10],
      onAccent: accent.onAccent,
      complementary: accent.complementary,
      bg: surface,
      bgBody: colorful ? bgBodyColorful : neutral[0],
      mainSelectedBg: accent.ramp[2],
      mainSelectedFg: accent.ramp[10],
      bg1: neutral[2],
      bg2: neutral[6],
      borderSubtle: neutral[5],
      borderStrong: neutral[8],
      text: neutral[11],
      text1: neutral[11],
      textLight: neutral[10],
      // Was #ccc on white (1.6:1), with a doc comment admitting it, in eight
      // places. Pointed at the readable step until those call sites move.
      textLight2: neutral[10],
      alert: status.alert,
      alertLight: status.alertLight,
      warning: status.warning,
      warningLight: status.warningLight,
      success: status.success,
      diff: diffColors(darkMode),
    },
    animation: {
      duration: durations.fast,
    },
    zIndex,
  };
};

// Styled-components requires overwriting the default theme
declare module 'styled-components' {
  export interface DefaultTheme {
    /** If true, make things dark */
    darkMode: boolean;
    /** If true, the app chrome (via ChromeTheme) is tinted with the main color */
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
    /** The elevation ladder. `boxShadow*` are aliases onto these. */
    elevation: { low: string; medium: string; high: string };
    /**
     * The type scale. Seven steps, so "slightly smaller than body" has one
     * answer; it used to have seven (0.7, 0.75, 0.8, 0.85, 0.875, 0.9, 0.95).
     */
    fontSize: {
      xs: string;
      sm: string;
      base: string;
      lg: string;
      xl: string;
      xl2: string;
      xl3: string;
    };
    lineHeight: { tight: string; snug: string; base: string };
    fontWeight: { normal: string; medium: string; bold: string };
    /** Radius steps. `radius` is an alias for `radii.md`. */
    radii: { sm: string; md: string; lg: string; full: string };
    /** Motion. `animation.duration` is an alias for `duration.fast`. */
    duration: { fast: string; base: string; slow: string };
    easing: { out: string; inOut: string };
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
     * Function that returns a size in rem for the given index.
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
      /**
       * The neutral palette: twelve steps with fixed roles, in the shape Radix
       * Colors established. The semantic aliases below are picked from it;
       * reach for a numbered step only when none of them fits.
       *
       * 1 app background · 2 subtle background · 3 component background ·
       * 4 component hover · 5 component active · 6 border subtle · 7 border ·
       * 8 border strong · 9 solid · 10 solid hover · 11 text low contrast ·
       * 12 text high contrast
       */
      neutral: Ramp;
      /** The same twelve roles in the user's main color. */
      accent: Ramp;
      /**
       * Main accent color, as a filled surface. Not readable as text — use
       * `accentText` for that.
       */
      main: string;
      /** Hover state of a filled accent surface */
      mainLight: string;
      /**
       * @deprecated Use `accentText`; this is the same value under its old
       * name. Every call site used it as accent-coloured text.
       */
      mainDark: string;
      /** The accent step that is readable as text, e.g. a link */
      accentText: string;
      /**
       * What sits on top of a filled accent surface. White or near-black,
       * whichever the fill can carry — not the page background, which is what
       * put six of the nine main-color presets below 4.5:1.
       */
      onAccent: string;
      /** Background color of selected items */
      mainSelectedBg: string;
      /** Foreground color of selected items */
      mainSelectedFg: string;
      /** Complementary color of main */
      complementary: string;
      /** The background color of the body, which is subtly different from bg */
      bgBody: string;
      /** Most common background color */
      bg: string;
      /** Subtle background color */
      bg1: string;
      /** Border color. Used as a border in 214 of its call sites. */
      bg2: string;
      /** A lighter border, for separators inside a surface */
      borderSubtle: string;
      /**
       * A border that identifies a control — a field's edge, a focus ring.
       * WCAG 1.4.11 wants those at 3:1, which `bg2` does not reach.
       */
      borderStrong: string;
      /** Main (body) text color */
      text: string;
      /**
       * @deprecated Identical to `text`. Was a barely-different hue of it.
       */
      text1: string;
      /** Lighter shade of text, still readable */
      textLight: string;
      /**
       * @deprecated Use `textLight`. This was #ccc on white (1.6:1) and now
       * resolves to the same value as `textLight`.
       */
      textLight2: string;
      /** Error / warning color */
      alert: string;
      alertLight: string;
      warning: string;
      warningLight: string;
      success: string;
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
