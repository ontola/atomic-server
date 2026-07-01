import type { JSONArray, JSONValue, JSONObject } from './value.js';

/** Single pen stroke on a canvas (matches Flutter `StrokeData` JSON). */
export type CanvasStroke = {
  color: number;
  width: number;
  path: [number, number][];
};

export const DEFAULT_STROKE_WIDTH = 10;

/**
 * Parse `strokeData` from a resource property.
 *
 * `strokeData`'s declared datatype is `json`, materialized as a
 * `LoroList<LoroMap>` — so `raw` is always a JSON array of stroke objects
 * (or `undefined` on an empty canvas). The earlier JSON-string fallback
 * was removed when the ontology moved off `string`; any pre-migration
 * canvas now needs a one-time rewrite.
 */
export function parseCanvasStrokes(raw: JSONValue | undefined): CanvasStroke[] {
  if (!Array.isArray(raw)) {
    return [];
  }

  const strokes: CanvasStroke[] = [];

  for (const item of raw) {
    const stroke = strokeFromJson(item);

    if (stroke) {
      strokes.push(stroke);
    }
  }

  return strokes;
}

export function strokeToJson(stroke: CanvasStroke): JSONObject {
  return {
    color: stroke.color,
    width: stroke.width,
    path: stroke.path,
  };
}

function strokeFromJson(item: unknown): CanvasStroke | undefined {
  if (!item || typeof item !== 'object' || Array.isArray(item)) {
    return undefined;
  }

  const obj = item as Record<string, unknown>;
  const color = obj.color;
  const width = obj.width;
  const path = obj.path;

  if (
    typeof color !== 'number' ||
    typeof width !== 'number' ||
    !Array.isArray(path)
  ) {
    return undefined;
  }

  const points: [number, number][] = [];

  for (const p of path) {
    if (!Array.isArray(p) || p.length < 2) {
      continue;
    }

    const x = p[0];
    const y = p[1];

    if (typeof x !== 'number' || typeof y !== 'number') {
      continue;
    }

    points.push([x, y]);
  }

  if (points.length === 0) {
    return undefined;
  }

  return { color, width, path: points };
}

/** Dark-mode stroke color (invert HSL lightness), matching Flutter. */
export function adjustStrokeColorForDarkMode(
  color: number,
  darkMode: boolean,
): string {
  const a = ((color >>> 24) & 0xff) / 255;
  let r = (color >> 16) & 0xff;
  let g = (color >> 8) & 0xff;
  let b = color & 0xff;

  if (darkMode) {
    const { h, s, l } = rgbToHsl(r, g, b);
    const inverted = hslToRgb(h, s, 1 - l);
    r = inverted.r;
    g = inverted.g;
    b = inverted.b;
  }

  return a < 1 ? `rgba(${r},${g},${b},${a})` : `rgb(${r},${g},${b})`;
}

function rgbToHsl(r: number, g: number, b: number) {
  const rn = r / 255;
  const gn = g / 255;
  const bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  let h = 0;
  let s = 0;
  const l = (max + min) / 2;

  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);

    switch (max) {
      case rn:
        h = (gn - bn) / d + (gn < bn ? 6 : 0);
        break;
      case gn:
        h = (bn - rn) / d + 2;
        break;
      default:
        h = (rn - gn) / d + 4;
    }

    h /= 6;
  }

  return { h, s, l };
}

function hslToRgb(h: number, s: number, l: number) {
  if (s === 0) {
    const v = Math.round(l * 255);

    return { r: v, g: v, b: v };
  }

  const hue2rgb = (p: number, q: number, t: number) => {
    let tt = t;

    if (tt < 0) tt += 1;
    if (tt > 1) tt -= 1;
    if (tt < 1 / 6) return p + (q - p) * 6 * tt;
    if (tt < 1 / 2) return q;
    if (tt < 2 / 3) return p + (q - p) * (2 / 3 - tt) * 6;

    return p;
  };

  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;

  return {
    r: Math.round(hue2rgb(p, q, h + 1 / 3) * 255),
    g: Math.round(hue2rgb(p, q, h) * 255),
    b: Math.round(hue2rgb(p, q, h - 1 / 3) * 255),
  };
}

export function strokesFromJSONArray(arr: JSONArray): CanvasStroke[] {
  return parseCanvasStrokes(arr);
}
