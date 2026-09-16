/**
 * The accent ramp, derived at runtime from the user's chosen main colour.
 *
 * Everything else in the token layer is static CSS (`tokens.css`). The accent
 * cannot be, because the main colour is a user setting — so it is the one ramp
 * we compute, and we write it to `:root` as custom properties rather than into
 * a React context. Changing the main colour or the theme is then a handful of
 * `setProperty` calls and *zero* re-renders: the old JS theme object made both
 * a context change that invalidated the entire tree.
 *
 * The steps mirror the neutral ramp's roles (see `tokens.css`), so "which
 * accent" has the same answer as "which grey": step 3 is a selected row, step 9
 * is a filled button, step 11 is accent-coloured text.
 */

import {
  contrastRatio,
  formatOklch,
  hexToOklch,
  oklchToRgb,
  type Oklch,
} from './oklch';
import { DEFAULT_MAIN_COLOR } from './presetColors';

/**
 * Lightness per step. Steps 9 and 10 are absent: the solid is the user's own
 * colour, only nudged into a range where white text sits on it legibly.
 */
const LIGHT_L = [
  0.99, 0.977, 0.958, 0.938, 0.916, 0.888, 0.85, 0.79, 0, 0, 0.52, 0.3,
];
const DARK_L = [0.19, 0.22, 0.27, 0.31, 0.35, 0.4, 0.46, 0.54, 0, 0, 0.78, 0.9];

/**
 * Chroma as a fraction of the main colour's own chroma, so a muted preset
 * produces a muted ramp and a vivid one a vivid ramp. Pale steps get a small
 * fraction: holding chroma constant while lightness rises makes the top of the
 * ramp look bleached rather than tinted.
 */
const CHROMA_SCALE = [
  0.05, 0.1, 0.18, 0.26, 0.34, 0.44, 0.56, 0.72, 1, 1, 0.85, 0.6,
];

/** Beyond this the pale steps clip out of sRGB and flatten into each other. */
const MAX_STEP_CHROMA = [
  0.012, 0.022, 0.038, 0.055, 0.07, 0.09, 0.11, 0.14, 0.4, 0.4, 0.16, 0.12,
];

/**
 * Where the solid step may sit. The upper bound in light mode is what keeps a
 * filled button's *edge* visible against a white page (WCAG 1.4.11 wants 3:1
 * for a control's boundary); the lower bound in dark mode does the same there.
 * Inside the range the colour is the user's own, untouched.
 */
const SOLID_L_LIGHT: [number, number] = [0.42, 0.7];
const SOLID_L_DARK: [number, number] = [0.5, 0.84];

/** What we may put on a filled accent surface. */
const ON_ACCENT_WHITE: Oklch = { l: 1, c: 0, h: 0 };
const ON_ACCENT_BLACK: Oklch = { l: 0.18, c: 0.005, h: 264 };

const WCAG_AA_TEXT = 4.5;
/** WCAG 1.4.11: a control's own boundary has to be findable. */
const WCAG_AA_NON_TEXT = 3;

/**
 * The page a filled control sits on, per theme — `--color-bg` in `tokens.css`.
 * Mirrored here because the search below needs it numerically; the contrast
 * gate reads the real values out of the CSS, so a drift between the two shows
 * up as a failing test rather than as an invisible button.
 */
const PAGE_LIGHT: Oklch = { l: 1, c: 0, h: 0 };
const PAGE_DARK: Oklch = { l: 0.21, c: 0.005, h: 264 };

const clamp = (x: number, lo: number, hi: number) =>
  Math.min(hi, Math.max(lo, x));

const contrastWith = (a: Oklch, b: Oklch) =>
  contrastRatio(oklchToRgb(a), oklchToRgb(b));

/** Where the hover step sits relative to the fill: further from the page. */
const hoverLightness = (solidL: number, darkMode: boolean) =>
  clamp(solidL + (darkMode ? 0.045 : -0.045), 0.12, 0.92);

/**
 * The single label colour this fill and its hover state can both carry, and
 * the worse of the two ratios under it.
 *
 * One label for both states, judged by its weakest pairing: a label chosen for
 * the resting fill that fails on hover is still a button nobody can read while
 * using it. Adaptive rather than fixed because the accent is the user's colour
 * — the old theme always used the page background as the label, which on the
 * mustard preset was 2.9:1. Seven of the eight presets failed AA that way.
 */
function bestLabel(
  solid: Oklch,
  hover: Oklch,
): { label: Oklch; ratio: number } {
  const score = (label: Oklch) =>
    Math.min(contrastWith(solid, label), contrastWith(hover, label));

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
 * point the same way. A filled control needs 3:1 against the page for its own
 * edge to be findable, which on a white page means *darker*; and a fill dark
 * enough for that carries white text rather than black. In dark mode both
 * invert. Since moving away from the page improves both, the search is
 * monotonic and terminates.
 *
 * So the mustard preset becomes a deeper ochre as a button in light mode. The
 * alternative is a button whose label or whose outline cannot be seen, and
 * `--accent-11` still carries the lighter mustard wherever the accent is text.
 */
function legibleSolidLightness(
  base: Oklch,
  range: [number, number],
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
      Math.min(contrastWith(solid, page), contrastWith(hover, page)) >=
      WCAG_AA_NON_TEXT;

    if (legible && visible) {
      break;
    }

    candidate += darkMode ? 0.01 : -0.01;
  }

  return clamp(candidate, 0.1, 0.95);
}

export interface AccentRamp {
  /** 12 OKLCH steps, index 0 = step 1. */
  steps: Oklch[];
  /** The complementary hue at the solid step's lightness and chroma. */
  complementary: Oklch;
  /** White or near-black, whichever this ramp's fill can actually carry. */
  onAccent: Oklch;
}

export function buildAccentRamp(
  mainHex: string,
  darkMode: boolean,
): AccentRamp {
  const base = hexToOklch(mainHex) ?? hexToOklch(DEFAULT_MAIN_COLOR)!;

  const lightnesses = darkMode ? DARK_L : LIGHT_L;
  const solidRange = darkMode ? SOLID_L_DARK : SOLID_L_LIGHT;
  const solidChroma = Math.min(base.c, 0.2);
  const solidL = legibleSolidLightness(base, solidRange, solidChroma, darkMode);

  const steps = lightnesses.map((l, i) => {
    if (i === 8) {
      return { l: solidL, c: solidChroma, h: base.h };
    }

    if (i === 9) {
      return {
        l: hoverLightness(solidL, darkMode),
        c: solidChroma,
        h: base.h,
      };
    }

    return {
      l,
      c: Math.min(base.c * CHROMA_SCALE[i]!, MAX_STEP_CHROMA[i]!),
      h: base.h,
    };
  });

  return {
    steps,
    complementary: {
      l: steps[8]!.l,
      c: steps[8]!.c,
      h: (base.h + 180) % 360,
    },
    onAccent: bestLabel(steps[8]!, steps[9]!).label,
  };
}

/**
 * The app chrome's neutral ramp in colourful mode.
 *
 * Colourful mode replaces the sidebar and navbar greys with tones of the main
 * colour, so no neutral ever sits on a coloured surface. Content stays neutral:
 * tinting the whole ramp reads as a monochrome wash rather than as colour.
 */
interface ChromeTone {
  name: string;
  l: number;
  c: number;
}

const CHROME_LIGHT: ChromeTone[] = [
  { name: 'bg', l: 0.93, c: 0.045 },
  { name: 'bg-subtle', l: 0.895, c: 0.042 },
  { name: 'border', l: 0.82, c: 0.036 },
  { name: 'text', l: 0.26, c: 0.05 },
  { name: 'text-subtle', l: 0.48, c: 0.04 },
];

const CHROME_DARK: ChromeTone[] = [
  { name: 'bg', l: 0.215, c: 0.028 },
  { name: 'bg-subtle', l: 0.26, c: 0.03 },
  { name: 'border', l: 0.36, c: 0.032 },
  { name: 'text', l: 0.93, c: 0.022 },
  { name: 'text-subtle', l: 0.76, c: 0.026 },
];

/** The barely-there tint behind the chrome. Full ramp tinting is a wash. */
const BODY_TINT_LIGHT = { l: 0.975, c: 0.012 };
const BODY_TINT_DARK = { l: 0.16, c: 0.018 };

export const ACCENT_STEP_VAR = (step: number) => `--accent-${step}`;

/**
 * Writes the accent ramp (and, in colourful mode, the chrome tones) onto an
 * element — `document.documentElement` in the app, a detached node in tests.
 */
export function applyAccentRamp(
  element: HTMLElement,
  options: { mainColor: string; darkMode: boolean; colorful: boolean },
): void {
  const { mainColor, darkMode, colorful } = options;
  const { steps, complementary, onAccent } = buildAccentRamp(
    mainColor,
    darkMode,
  );

  steps.forEach((step, i) => {
    element.style.setProperty(ACCENT_STEP_VAR(i + 1), formatOklch(step));
  });

  element.style.setProperty(
    '--accent-complementary',
    formatOklch(complementary),
  );
  element.style.setProperty('--color-on-accent', formatOklch(onAccent));

  const base = hexToOklch(mainColor) ?? hexToOklch(DEFAULT_MAIN_COLOR)!;
  const tones = darkMode ? CHROME_DARK : CHROME_LIGHT;
  const bodyTint = darkMode ? BODY_TINT_DARK : BODY_TINT_LIGHT;

  for (const tone of tones) {
    // Outside colourful mode the chrome vars resolve to the neutral ones, which
    // `tokens.css` already sets as their fallback — so clearing is enough.
    element.style.setProperty(
      `--chrome-${tone.name}`,
      colorful ? formatOklch({ l: tone.l, c: tone.c, h: base.h }) : '',
    );
  }

  element.style.setProperty(
    '--color-bg-body',
    colorful ? formatOklch({ ...bodyTint, h: base.h }) : '',
  );
}
