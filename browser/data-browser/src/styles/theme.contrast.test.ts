import { describe, expect, it } from 'vitest';
import { buildTheme } from './theme';
import { contrastRatio, hexToRgb } from './oklch';
import { DEFAULT_MAIN_COLOR, presetColors } from './presetColors';

/**
 * The accessibility gate for the palette.
 *
 * The theme this replaced shipped a colour its own doc comment described as
 * "not accessible for some" (`textLight2`, #ccc on white — 1.6:1) and used it
 * in eight places. It shipped it because nothing checked. This checks.
 *
 * It asserts against the built theme rather than a copy of the values, so a
 * ramp edit cannot pass here and fail in the browser. And it runs over every
 * main colour the appearance settings offer, because the accent is a user
 * setting: a gate that only covers the default blue would have missed that six
 * of the nine presets produced a primary button below AA.
 */

const WCAG_AA_TEXT = 4.5;
/** WCAG AA for UI components and graphical objects. */
const WCAG_AA_NON_TEXT = 3;

const ratio = (a: string, b: string) =>
  contrastRatio(hexToRgb(a)!, hexToRgb(b)!);

const themes = [
  ['light', buildTheme(false, DEFAULT_MAIN_COLOR)],
  ['dark', buildTheme(true, DEFAULT_MAIN_COLOR)],
] as const;

describe.each(themes)('neutral palette (%s)', (name, theme) => {
  const { colors } = theme;

  /** Every background a component may legitimately put text on. */
  const backgrounds = [
    ['bgBody', colors.bgBody],
    ['bg', colors.bg],
    ['bg1', colors.bg1],
    ['neutral 4 (hover)', colors.neutral[3]],
    ['neutral 5 (active)', colors.neutral[4]],
  ] as const;

  it.each(backgrounds)('body text is readable on %s', (_label, background) => {
    expect(ratio(colors.text, background)).toBeGreaterThanOrEqual(WCAG_AA_TEXT);
  });

  // The step that replaced both `textLight` and the inaccessible `textLight2`.
  it.each(backgrounds)(
    'subtle text is readable on %s',
    (_label, background) => {
      expect(ratio(colors.textLight, background)).toBeGreaterThanOrEqual(
        WCAG_AA_TEXT,
      );
    },
  );

  it('textLight2 is no longer the inaccessible value it was', () => {
    expect(colors.textLight2).toBe(colors.textLight);
  });

  it('borders are distinguishable from the surfaces they separate', () => {
    // A separator only has to be visible.
    expect(ratio(colors.bg2, colors.bg)).toBeGreaterThanOrEqual(1.3);
    // A border that identifies a control — a field's edge, a focus ring — is
    // non-text content that WCAG 1.4.11 requires at 3:1.
    expect(ratio(colors.borderStrong, colors.bg)).toBeGreaterThanOrEqual(
      WCAG_AA_NON_TEXT,
    );
  });

  it('a surface is distinguishable from the page behind it', () => {
    // Both used to be pure black in dark mode, so a card could only be found
    // by its border.
    expect(colors.bg).not.toBe(colors.bgBody);
  });

  it('the ramp moves monotonically away from the app background', () => {
    for (let i = 1; i < colors.neutral.length; i++) {
      const previous = hexToRgb(colors.neutral[i - 1]!)!;
      const current = hexToRgb(colors.neutral[i]!)!;
      const brighter = current.r + current.g + current.b;
      const dimmer = previous.r + previous.g + previous.b;

      expect(name === 'dark' ? brighter > dimmer : brighter < dimmer).toBe(
        true,
      );
    }
  });

  it.each(['alert', 'warning', 'success'] as const)(
    '%s is distinguishable against the page',
    key => {
      expect(ratio(colors[key], colors.bg)).toBeGreaterThanOrEqual(
        WCAG_AA_NON_TEXT,
      );
    },
  );
});

describe('accent palette', () => {
  const colors = [...presetColors, DEFAULT_MAIN_COLOR];

  describe.each([
    ['light', false],
    ['dark', true],
  ] as const)('%s', (_name, darkMode) => {
    it.each(colors)('%s: accent text is readable on the page', picked => {
      const { colors: c } = buildTheme(darkMode, picked);

      for (const background of [c.bgBody, c.bg]) {
        expect(ratio(c.accentText, background)).toBeGreaterThanOrEqual(
          WCAG_AA_TEXT,
        );
      }
    });

    it.each(colors)('%s: accent text is readable on a selected row', picked => {
      const { colors: c } = buildTheme(darkMode, picked);

      expect(ratio(c.mainSelectedFg, c.mainSelectedBg)).toBeGreaterThanOrEqual(
        WCAG_AA_TEXT,
      );
    });

    it.each(colors)('%s: a filled button carries its label', picked => {
      const { colors: c } = buildTheme(darkMode, picked);

      // Resting and hover both: a hover state below the threshold is still a
      // button nobody can read while using it.
      for (const fill of [c.main, c.mainLight]) {
        expect(ratio(fill, c.onAccent)).toBeGreaterThanOrEqual(WCAG_AA_TEXT);
      }
    });

    it.each(colors)(
      '%s: the filled button is visible against the page',
      picked => {
        const { colors: c } = buildTheme(darkMode, picked);

        expect(ratio(c.main, c.bg)).toBeGreaterThanOrEqual(WCAG_AA_NON_TEXT);
      },
    );

    it('an unusable main colour falls back instead of throwing', () => {
      expect(() => buildTheme(darkMode, 'not-a-colour')).not.toThrow();
      expect(buildTheme(darkMode, '').colors.accent).toHaveLength(12);
    });
  });
});
