/**
 * The palette and the scales the theme is built from.
 *
 * This is the unification: one place that decides what the greys are, what the
 * accent steps are, and what the type, radius, elevation and motion scales are.
 * Before, `styling.tsx` held three background steps and four text steps derived
 * with polished's `lighten`/`darken`, and the other 1155 styled components
 * decided the rest for themselves — 56 distinct font sizes, 53 gaps, 108
 * paddings, 39 shadows, 107 stray colour literals.
 *
 * Authored in OKLCH because it is perceptually uniform: the same lightness step
 * looks like the same step at every hue. `lighten`/`darken` move HSL lightness,
 * where the same delta is a big jump in blue and a small one in yellow, so the
 * old ramp drifted as the user changed their main colour.
 *
 * Emitted as hex, because the theme's colours are handed to polished and to
 * call sites that append an 8-bit alpha suffix, and neither speaks `oklch()`.
 */

import {
  contrastRatio,
  formatHex,
  hexToOklch,
  oklchToRgb,
  type Oklch,
} from './oklch';
import { DEFAULT_MAIN_COLOR } from './presetColors';

/** Twelve steps with fixed roles, in the shape Radix Colors established. */
export type Ramp = readonly [
  /** 1 app background */ string,
  /** 2 subtle background */ string,
  /** 3 component background */ string,
  /** 4 component hover */ string,
  /** 5 component active */ string,
  /** 6 border, subtle */ string,
  /** 7 border */ string,
  /** 8 border, strong */ string,
  /** 9 solid */ string,
  /** 10 solid hover */ string,
  /** 11 text, low contrast */ string,
  /** 12 text, high contrast */ string,
];

/**
 * Hue 264 at very low chroma: a true grey next to a coloured accent reads as
 * slightly warm, and a hint of the cool side corrects for it.
 */
const NEUTRAL_HUE = 264;

const NEUTRAL_LIGHT: ReadonlyArray<readonly [number, number]> = [
  [0.98, 0.0015],
  [0.965, 0.0025],
  [0.945, 0.0035],
  [0.925, 0.0045],
  [0.905, 0.0055],
  [0.875, 0.0065],
  [0.835, 0.0075],
  [0.77, 0.009],
  [0.64, 0.012],
  [0.6, 0.012],
  [0.5, 0.012],
  [0.24, 0.012],
];

const NEUTRAL_DARK: ReadonlyArray<readonly [number, number]> = [
  [0.175, 0.004],
  [0.21, 0.005],
  [0.25, 0.0065],
  [0.28, 0.0075],
  [0.31, 0.0085],
  [0.35, 0.0095],
  [0.405, 0.011],
  [0.49, 0.013],
  [0.54, 0.015],
  [0.585, 0.015],
  [0.77, 0.013],
  [0.95, 0.008],
];

const toRamp = (steps: ReadonlyArray<readonly [number, number]>): Ramp =>
  steps.map(([l, c]) => formatHex({ l, c, h: NEUTRAL_HUE })) as unknown as Ramp;

export const neutralRamp = (darkMode: boolean): Ramp =>
  toRamp(darkMode ? NEUTRAL_DARK : NEUTRAL_LIGHT);

// ─────────────────────────────── Accent ────────────────────────────────────

/** Lightness per accent step. Steps 9 and 10 come from the user's colour. */
const ACCENT_L_LIGHT = [
  0.99, 0.977, 0.958, 0.938, 0.916, 0.888, 0.85, 0.79, 0, 0, 0.52, 0.3,
];
const ACCENT_L_DARK = [
  0.19, 0.22, 0.27, 0.31, 0.35, 0.4, 0.46, 0.54, 0, 0, 0.78, 0.9,
];

/**
 * Chroma as a fraction of the main colour's own, so a muted preset produces a
 * muted ramp. Pale steps take a small fraction: holding chroma constant while
 * lightness rises reads as bleached rather than tinted.
 */
const ACCENT_CHROMA_SCALE = [
  0.05, 0.1, 0.18, 0.26, 0.34, 0.44, 0.56, 0.72, 1, 1, 0.85, 0.6,
];

/** Beyond this the pale steps clip out of sRGB and flatten into each other. */
const ACCENT_CHROMA_CAP = [
  0.012, 0.022, 0.038, 0.055, 0.07, 0.09, 0.11, 0.14, 0.4, 0.4, 0.16, 0.12,
];

const SOLID_L_LIGHT: readonly [number, number] = [0.42, 0.7];
const SOLID_L_DARK: readonly [number, number] = [0.5, 0.84];

/** What may sit on a filled accent surface. */
const ON_ACCENT_WHITE: Oklch = { l: 1, c: 0, h: 0 };
const ON_ACCENT_BLACK: Oklch = { l: 0.18, c: 0.005, h: NEUTRAL_HUE };

/** The page a filled control sits on, per theme: neutral step 1 or white. */
const PAGE_LIGHT: Oklch = { l: 1, c: 0, h: 0 };
const PAGE_DARK: Oklch = { l: 0.21, c: 0.005, h: NEUTRAL_HUE };

const WCAG_AA_TEXT = 4.5;
/** WCAG 1.4.11: a control's own boundary has to be findable. */
const WCAG_AA_NON_TEXT = 3;

const clamp = (x: number, lo: number, hi: number) =>
  Math.min(hi, Math.max(lo, x));

const contrast = (a: Oklch, b: Oklch) =>
  contrastRatio(oklchToRgb(a), oklchToRgb(b));

const hoverLightness = (solidL: number, darkMode: boolean) =>
  clamp(solidL + (darkMode ? 0.045 : -0.045), 0.12, 0.92);

/**
 * The single label colour a fill and its hover state can both carry, and the
 * worse of the two ratios under it.
 *
 * One label for both states, judged by its weakest pairing: a label chosen for
 * the resting fill that fails on hover is still a button nobody can read while
 * using it. Adaptive rather than fixed because the accent is the user's colour
 * — the old theme always used the page background as the label, which on the
 * mustard preset was 2.5:1. Six of the nine presets failed AA that way.
 */
function bestLabel(
  solid: Oklch,
  hover: Oklch,
): { label: Oklch; ratio: number } {
  const score = (label: Oklch) =>
    Math.min(contrast(solid, label), contrast(hover, label));

  const white = score(ON_ACCENT_WHITE);
  const black = score(ON_ACCENT_BLACK);

  return white >= black
    ? { label: ON_ACCENT_WHITE, ratio: white }
    : { label: ON_ACCENT_BLACK, ratio: black };
}

/**
 * Darkens (light theme) or lightens (dark theme) the fill until it can both be
 * seen and be written on.
 *
 * The direction is the theme's, not the colour's, because the two requirements
 * point the same way: a filled control needs 3:1 against the page for its edge
 * to be findable, which on a white page means darker, and a fill dark enough
 * for that carries white text rather than black. In dark mode both invert.
 * Moving away from the page improves both, so the search terminates.
 *
 * So the mustard preset becomes a deeper ochre as a button in light mode. The
 * alternative is a button whose label or whose outline cannot be seen, and
 * accent step 11 still carries the lighter mustard wherever the accent is text.
 */
function legibleSolidLightness(
  base: Oklch,
  range: readonly [number, number],
  chroma: number,
  darkMode: boolean,
): number {
  const page = darkMode ? PAGE_DARK : PAGE_LIGHT;
  let candidate = clamp(base.l, range[0], range[1]);

  for (let i = 0; i < 80; i++) {
    const solid: Oklch = { l: candidate, c: chroma, h: base.h };
    const hover: Oklch = {
      l: hoverLightness(candidate, darkMode),
      c: chroma,
      h: base.h,
    };

    const legible = bestLabel(solid, hover).ratio >= WCAG_AA_TEXT;
    const visible =
      Math.min(contrast(solid, page), contrast(hover, page)) >=
      WCAG_AA_NON_TEXT;

    if (legible && visible) break;

    candidate += darkMode ? 0.01 : -0.01;
  }

  return clamp(candidate, 0.1, 0.95);
}

export interface AccentRamp {
  /** 12 steps, index 0 = step 1. */
  ramp: Ramp;
  /** The complementary hue at the solid step's lightness and chroma. */
  complementary: string;
  /** White or near-black, whichever this ramp's fill can actually carry. */
  onAccent: string;
}

export function buildAccentRamp(
  mainHex: string,
  darkMode: boolean,
): AccentRamp {
  const base = hexToOklch(mainHex) ?? hexToOklch(DEFAULT_MAIN_COLOR)!;

  const lightnesses = darkMode ? ACCENT_L_DARK : ACCENT_L_LIGHT;
  const solidRange = darkMode ? SOLID_L_DARK : SOLID_L_LIGHT;
  const solidChroma = Math.min(base.c, 0.2);
  const solidL = legibleSolidLightness(base, solidRange, solidChroma, darkMode);

  const steps: Oklch[] = lightnesses.map((l, i) => {
    if (i === 8) return { l: solidL, c: solidChroma, h: base.h };

    if (i === 9) {
      return {
        l: hoverLightness(solidL, darkMode),
        c: solidChroma,
        h: base.h,
      };
    }

    return {
      l,
      c: Math.min(base.c * ACCENT_CHROMA_SCALE[i]!, ACCENT_CHROMA_CAP[i]!),
      h: base.h,
    };
  });

  return {
    ramp: steps.map(formatHex) as unknown as Ramp,
    complementary: formatHex({
      l: steps[8]!.l,
      c: steps[8]!.c,
      h: (base.h + 180) % 360,
    }),
    onAccent: formatHex(bestLabel(steps[8]!, steps[9]!).label),
  };
}

// ────────────────────────── Non-colour scales ──────────────────────────────

/**
 * Seven steps, so "slightly smaller than body" has exactly one answer. It
 * previously had seven: 0.7, 0.75, 0.8, 0.85, 0.875, 0.9 and 0.95rem were all
 * in use, and nobody had chosen any of them.
 */
export const fontSizes = {
  xs: '0.75rem',
  sm: '0.875rem',
  base: '1rem',
  lg: '1.125rem',
  xl: '1.375rem',
  xl2: '1.625rem',
  xl3: '2rem',
} as const;

export const lineHeights = {
  tight: '1.15',
  snug: '1.35',
  base: '1.5',
} as const;

export const fontWeights = {
  normal: '400',
  medium: '500',
  bold: '700',
} as const;

export const radii = {
  sm: '5px',
  md: '9px',
  lg: '14px',
  full: '9999px',
} as const;

/** One ladder of three, replacing 39 hand-written shadows. */
export const elevations = (darkMode: boolean) =>
  darkMode
    ? ({
        // Shadows barely register on a dark page; kept non-zero so a floating
        // surface still lifts a little, with the border carrying the rest.
        low: '0 1px 2px rgba(0, 0, 0, 0.3)',
        medium: '0 2px 8px rgba(0, 0, 0, 0.4)',
        high: '0 8px 32px rgba(0, 0, 0, 0.55)',
      } as const)
    : ({
        low: '0 1px 2px rgba(0, 0, 0, 0.04), 0 2px 6px rgba(0, 0, 0, 0.04)',
        medium: '0 2px 4px rgba(0, 0, 0, 0.05), 0 6px 16px rgba(0, 0, 0, 0.07)',
        high: '0 4px 8px rgba(0, 0, 0, 0.06), 0 16px 40px rgba(0, 0, 0, 0.12)',
      } as const);

export const durations = {
  fast: '100ms',
  base: '150ms',
  slow: '300ms',
} as const;

export const easings = {
  out: 'cubic-bezier(0.22, 1, 0.36, 1)',
  inOut: 'cubic-bezier(0.65, 0, 0.35, 1)',
} as const;

/** Status colours, as OKLCH-authored hex per theme. */
export const statusColors = (darkMode: boolean) =>
  darkMode
    ? {
        alert: formatHex({ l: 0.69, c: 0.155, h: 22 }),
        alertLight: formatHex({ l: 0.74, c: 0.13, h: 22 }),
        warning: formatHex({ l: 0.81, c: 0.14, h: 74 }),
        warningLight: formatHex({ l: 0.87, c: 0.1, h: 74 }),
        success: formatHex({ l: 0.72, c: 0.14, h: 152 }),
      }
    : {
        alert: formatHex({ l: 0.605, c: 0.155, h: 22 }),
        alertLight: formatHex({ l: 0.67, c: 0.145, h: 22 }),
        warning: formatHex({ l: 0.66, c: 0.14, h: 74 }),
        warningLight: formatHex({ l: 0.78, c: 0.12, h: 74 }),
        success: formatHex({ l: 0.64, c: 0.14, h: 152 }),
      };

export const diffColors = (darkMode: boolean) =>
  darkMode
    ? {
        addedBg: formatHex({ l: 0.3, c: 0.06, h: 150 }),
        addedFg: formatHex({ l: 0.9, c: 0.07, h: 150 }),
        removedBg: formatHex({ l: 0.3, c: 0.07, h: 22 }),
        removedFg: formatHex({ l: 0.9, c: 0.07, h: 22 }),
      }
    : {
        addedBg: formatHex({ l: 0.95, c: 0.06, h: 150 }),
        addedFg: formatHex({ l: 0.32, c: 0.09, h: 150 }),
        removedBg: formatHex({ l: 0.9, c: 0.07, h: 22 }),
        removedFg: formatHex({ l: 0.32, c: 0.11, h: 22 }),
      };
