import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { buildAccentRamp } from './accentRamp';
import { contrastRatio, oklchToRgb, parseOklch, type Oklch } from './oklch';
import { DEFAULT_MAIN_COLOR, presetColors } from './presetColors';

/**
 * The accessibility gate for the token layer.
 *
 * The theme this replaced shipped a colour its own doc comment described as
 * "not accessible for some" (`textLight2`, #ccc on white — 1.6:1) and used it
 * in eight places. It shipped it because nothing checked. This checks.
 *
 * The test reads the CSS that actually ships rather than a copy of the values,
 * so a ramp edit cannot pass here and fail in the browser.
 */

const WCAG_AA_TEXT = 4.5;
/** WCAG AA for UI components and graphical objects. */
const WCAG_AA_NON_TEXT = 3;

const cssPath = fileURLToPath(new URL('./tokens.css', import.meta.url));
const css = readFileSync(cssPath, 'utf-8');

/**
 * The token values for one theme. `:root` first, then the dark block layered
 * over it, mirroring the cascade.
 */
function readBlock(selector: string): Map<string, string> {
  const start = css.indexOf(selector + ' {');

  if (start === -1) {
    throw new Error(`No ${selector} block in tokens.css`);
  }

  const body = css.slice(start, css.indexOf('\n}', start));
  const out = new Map<string, string>();

  for (const [, name, value] of body.matchAll(/(--[\w-]+):\s*([^;]+);/g)) {
    out.set(name!, value!.trim());
  }

  return out;
}

const lightTokens = readBlock(':root');
const darkTokens = new Map([
  ...lightTokens,
  ...readBlock(":root[data-theme='dark']"),
]);

/** Resolves a token through however many `var(--x)` hops it takes. */
function resolve(tokens: Map<string, string>, name: string): Oklch {
  let value = tokens.get(name);

  for (let hop = 0; value && hop < 10; hop++) {
    const indirect = /^var\((--[\w-]+)\)$/.exec(value);

    if (!indirect) break;

    value = tokens.get(indirect[1]!);
  }

  const parsed = value && parseOklch(value);

  if (!parsed) {
    throw new Error(`Token ${name} is not a plain oklch() value: ${value}`);
  }

  return parsed;
}

function ratio(tokens: Map<string, string>, fg: string, bg: string): number {
  return contrastRatio(
    oklchToRgb(resolve(tokens, fg)),
    oklchToRgb(resolve(tokens, bg)),
  );
}

const themes = [
  ['light', lightTokens],
  ['dark', darkTokens],
] as const;

/** Every background a component may legitimately put text on. */
const BACKGROUNDS = [
  '--color-bg-body',
  '--color-bg',
  '--color-bg-subtle',
  '--color-bg-hover',
  '--color-bg-active',
];

describe.each(themes)('neutral ramp (%s)', (_name, tokens) => {
  it.each(BACKGROUNDS)('body text is readable on %s', background => {
    expect(ratio(tokens, '--color-text', background)).toBeGreaterThanOrEqual(
      WCAG_AA_TEXT,
    );
  });

  // The step that replaced both `textLight` and the inaccessible `textLight2`.
  it.each(BACKGROUNDS)('subtle text is readable on %s', background => {
    expect(
      ratio(tokens, '--color-text-subtle', background),
    ).toBeGreaterThanOrEqual(WCAG_AA_TEXT);
  });

  it('borders are distinguishable from the surfaces they separate', () => {
    // A separator only has to be visible.
    expect(
      ratio(tokens, '--color-border', '--color-bg'),
    ).toBeGreaterThanOrEqual(1.3);
    // A border that identifies a control — a form field's edge, a focus ring —
    // is non-text content that WCAG 1.4.11 requires at 3:1.
    expect(
      ratio(tokens, '--color-border-strong', '--color-bg'),
    ).toBeGreaterThanOrEqual(WCAG_AA_NON_TEXT);
  });

  it('the ramp increases monotonically away from the app background', () => {
    const steps = Array.from({ length: 12 }, (_, i) =>
      resolve(tokens, `--neutral-${i + 1}`),
    );

    for (let i = 1; i < steps.length; i++) {
      const previous = steps[i - 1]!.l;
      const current = steps[i]!.l;

      expect(_name === 'dark' ? current > previous : current < previous).toBe(
        true,
      );
    }
  });
});

describe.each(themes)('status colours (%s)', (_name, tokens) => {
  it.each(['--color-alert', '--color-warning', '--color-success'])(
    '%s is distinguishable against the page',
    token => {
      expect(ratio(tokens, token, '--color-bg')).toBeGreaterThanOrEqual(
        WCAG_AA_NON_TEXT,
      );
    },
  );
});

/**
 * The accent is the user's own colour, so the gate has to hold for every
 * colour they can pick — not just the default blue. The presets are the ones
 * the appearance settings offer.
 */
describe('accent ramp', () => {
  const colors = [...presetColors, DEFAULT_MAIN_COLOR];

  describe.each([
    ['light', false],
    ['dark', true],
  ] as const)('%s', (themeName, darkMode) => {
    const tokens = darkMode ? darkTokens : lightTokens;
    const pageBackgrounds = ['--color-bg-body', '--color-bg'] as const;

    it.each(colors)('%s: accent text is readable on the page', color => {
      const { steps } = buildAccentRamp(color, darkMode);
      const accentText = oklchToRgb(steps[10]!);

      for (const background of pageBackgrounds) {
        expect(
          contrastRatio(accentText, oklchToRgb(resolve(tokens, background))),
        ).toBeGreaterThanOrEqual(WCAG_AA_TEXT);
      }
    });

    it.each(colors)('%s: accent text is readable on a selected row', color => {
      const { steps } = buildAccentRamp(color, darkMode);

      expect(
        contrastRatio(oklchToRgb(steps[10]!), oklchToRgb(steps[2]!)),
      ).toBeGreaterThanOrEqual(WCAG_AA_TEXT);
    });

    it.each(colors)('%s: a filled button carries its label', color => {
      const { steps, onAccent } = buildAccentRamp(color, darkMode);

      // Both resting and hover: a hover state that drops below the threshold
      // is still a button nobody can read while using it.
      for (const solid of [steps[8]!, steps[9]!]) {
        expect(
          contrastRatio(oklchToRgb(solid), oklchToRgb(onAccent)),
        ).toBeGreaterThanOrEqual(WCAG_AA_TEXT);
      }
    });

    it.each(colors)('%s: the solid is visible against the page', color => {
      const { steps } = buildAccentRamp(color, darkMode);

      expect(
        contrastRatio(
          oklchToRgb(steps[8]!),
          oklchToRgb(resolve(tokens, '--color-bg')),
        ),
      ).toBeGreaterThanOrEqual(WCAG_AA_NON_TEXT);
    });

    it(`${themeName}: an unparseable main colour falls back instead of throwing`, () => {
      expect(() => buildAccentRamp('not-a-colour', darkMode)).not.toThrow();
      expect(buildAccentRamp('not-a-colour', darkMode).steps).toHaveLength(12);
    });
  });
});
