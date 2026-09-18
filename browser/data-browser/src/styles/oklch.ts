/**
 * Oklab / OKLCH ↔ sRGB, plus WCAG contrast.
 *
 * The token ramps are authored in OKLCH because it is perceptually uniform:
 * the same lightness step looks like the same step at every hue. The previous
 * theme derived its neutrals with polished's `lighten`/`darken`, which move HSL
 * lightness — there the same delta is a large jump in blue and a small one in
 * yellow, so the ramp drifted as the user changed their main colour.
 *
 * Math from Björn Ottosson's Oklab reference
 * (https://bottosson.github.io/posts/oklab/). No dependency: we need the
 * inverse too, for the contrast gate, and it is thirty lines.
 */

export interface Oklch {
  /** Perceptual lightness, 0..1 */
  l: number;
  /** Chroma, 0..~0.37 in sRGB */
  c: number;
  /** Hue in degrees, 0..360 */
  h: number;
}

export interface Rgb {
  /** 0..255 */
  r: number;
  g: number;
  b: number;
}

const clamp01 = (x: number) => Math.min(1, Math.max(0, x));

/** sRGB gamma encode, on 0..1 channels. */
const encodeGamma = (x: number) =>
  x <= 0.0031308 ? 12.92 * x : 1.055 * Math.pow(x, 1 / 2.4) - 0.055;

/** sRGB gamma decode, on 0..1 channels. */
const decodeGamma = (x: number) =>
  x <= 0.04045 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4);

export function oklchToRgb({ l, c, h }: Oklch): Rgb {
  const hRad = (h * Math.PI) / 180;
  const a = c * Math.cos(hRad);
  const b = c * Math.sin(hRad);

  const lCube = l + 0.3963377774 * a + 0.2158037573 * b;
  const mCube = l - 0.1055613458 * a - 0.0638541728 * b;
  const sCube = l - 0.0894841775 * a - 1.291485548 * b;

  const lLin = lCube ** 3;
  const mLin = mCube ** 3;
  const sLin = sCube ** 3;

  // Linear sRGB. Out-of-gamut values are clipped per channel, which is what
  // browsers do for an `oklch()` they cannot display, so our computed value
  // matches what is actually painted.
  const rLin = 4.0767416621 * lLin - 3.3077115913 * mLin + 0.2309699292 * sLin;
  const gLin = -1.2684380046 * lLin + 2.6097574011 * mLin - 0.3413193965 * sLin;
  const bLin = -0.0041960863 * lLin - 0.7034186147 * mLin + 1.707614701 * sLin;

  return {
    r: Math.round(clamp01(encodeGamma(clamp01(rLin))) * 255),
    g: Math.round(clamp01(encodeGamma(clamp01(gLin))) * 255),
    b: Math.round(clamp01(encodeGamma(clamp01(bLin))) * 255),
  };
}

export function rgbToOklch({ r, g, b }: Rgb): Oklch {
  const rLin = decodeGamma(r / 255);
  const gLin = decodeGamma(g / 255);
  const bLin = decodeGamma(b / 255);

  const lCube = Math.cbrt(
    0.4122214708 * rLin + 0.5363325363 * gLin + 0.0514459929 * bLin,
  );
  const mCube = Math.cbrt(
    0.2119034982 * rLin + 0.6806995451 * gLin + 0.1073969566 * bLin,
  );
  const sCube = Math.cbrt(
    0.0883024619 * rLin + 0.2817188376 * gLin + 0.6299787005 * bLin,
  );

  const l = 0.2104542553 * lCube + 0.793617785 * mCube - 0.0040720468 * sCube;
  const a = 1.9779984951 * lCube - 2.428592205 * mCube + 0.4505937099 * sCube;
  const bb = 0.0259040371 * lCube + 0.7827717662 * mCube - 0.808675766 * sCube;

  const c = Math.sqrt(a * a + bb * bb);
  // A neutral has no meaningful hue; 0 keeps the value stable instead of
  // letting floating-point noise pick one.
  const h = c < 1e-6 ? 0 : ((Math.atan2(bb, a) * 180) / Math.PI + 360) % 360;

  return { l, c, h };
}

/** Accepts `#rgb`, `#rrggbb`, with or without the leading `#`. */
export function hexToRgb(hex: string): Rgb | undefined {
  const raw = hex.trim().replace(/^#/, '');

  const full =
    raw.length === 3
      ? raw
          .split('')
          .map(ch => ch + ch)
          .join('')
      : raw;

  if (!/^[0-9a-fA-F]{6}$/.test(full)) {
    return undefined;
  }

  return {
    r: parseInt(full.slice(0, 2), 16),
    g: parseInt(full.slice(2, 4), 16),
    b: parseInt(full.slice(4, 6), 16),
  };
}

export function hexToOklch(hex: string): Oklch | undefined {
  const rgb = hexToRgb(hex);

  return rgb && rgbToOklch(rgb);
}

/** Serialises as OKLCH. Rounded so emitted values stay legible. */
export function formatOklch({ l, c, h }: Oklch): string {
  return `oklch(${l.toFixed(4)} ${c.toFixed(4)} ${h.toFixed(2)})`;
}

/**
 * Serialises as sRGB hex.
 *
 * The ramps are *authored* in OKLCH because it is perceptually uniform, but
 * the theme hands its colours to polished (`transparentize`, `lighten`) and to
 * call sites that append an 8-bit alpha suffix. Neither understands `oklch()`,
 * so the theme carries hex and OKLCH stays the authoring space.
 */
export function formatHex(color: Oklch): string {
  const { r, g, b } = oklchToRgb(color);

  return (
    '#' +
    [r, g, b].map(channel => channel.toString(16).padStart(2, '0')).join('')
  );
}

/** Parses the `oklch(L C H)` form this module emits and `tokens.css` authors. */
export function parseOklch(value: string): Oklch | undefined {
  const match = /^oklch\(\s*([\d.]+)\s+([\d.]+)\s+([\d.]+)\s*\)$/.exec(
    value.trim(),
  );

  if (!match) {
    return undefined;
  }

  return { l: +match[1]!, c: +match[2]!, h: +match[3]! };
}

/** WCAG 2.1 relative luminance. */
export function relativeLuminance({ r, g, b }: Rgb): number {
  return (
    0.2126 * decodeGamma(r / 255) +
    0.7152 * decodeGamma(g / 255) +
    0.0722 * decodeGamma(b / 255)
  );
}

/** WCAG 2.1 contrast ratio, 1..21. Order of the arguments does not matter. */
export function contrastRatio(a: Rgb, b: Rgb): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);

  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

export function oklchContrast(a: Oklch, b: Oklch): number {
  return contrastRatio(oklchToRgb(a), oklchToRgb(b));
}
