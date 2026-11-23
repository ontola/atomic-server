import type { JSONArray, JSONValue, JSONObject } from './value.js';

/**
 * One element on a canvas. A plain pen stroke matches Flutter's `StrokeData`
 * JSON. Text and image elements reuse that same shape (`path` holds a single
 * anchor point, `width` is a hairline) and add optional fields, so an older
 * reader that only knows strokes still parses the list and draws a speck
 * instead of failing.
 */
export type CanvasStroke = {
  color: number;
  width: number;
  path: [number, number][];
  /** Absent for a pen stroke. */
  kind?: 'text' | 'image' | 'shape' | 'arrow';
  /**
   * Stable id of a shape or arrow. Elements are otherwise addressed by their
   * position in the list, which shifts on delete; arrows bind to shapes by id.
   */
  id?: string;
  /** `kind: 'shape'`: the outline. `path[0]` is the top-left corner. */
  shape?: 'rect' | 'ellipse';
  /**
   * `kind: 'arrow'`: `path` is `[start, end]`, the position of each end when
   * it is not bound to a shape (and the last known one when it is).
   */
  from?: string;
  to?: string;
  /**
   * `kind: 'arrow'`: offset of the quadratic control point from the straight
   * midpoint. Absent for a straight arrow.
   */
  bend?: [number, number];
  /** `kind: 'text'` or `'shape'`: the text, `\n` separates lines. */
  text?: string;
  /** `kind: 'text'` or `'shape'`: font size in canvas units. */
  size?: number;
  /** `kind: 'image'`: subject of the uploaded File resource. */
  src?: string;
  /** `kind: 'image'` or `'shape'`: drawn size in canvas units. */
  w?: number;
  h?: number;
};

/** Stroke width stored on text and image elements. */
export const ELEMENT_HAIRLINE_WIDTH = 0.01;

export const DEFAULT_STROKE_WIDTH = 10;

/** A short random id for a shape or arrow. */
export function newCanvasElementId(): string {
  return Math.random().toString(36).slice(2, 8).padEnd(6, '0');
}

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
  const json: JSONObject = {
    color: stroke.color,
    width: stroke.width,
    path: stroke.path,
  };

  if (stroke.kind === 'text') {
    json.kind = 'text';
    json.text = stroke.text ?? '';
    json.size = stroke.size ?? 24;
  } else if (stroke.kind === 'image' && stroke.src) {
    json.kind = 'image';
    json.src = stroke.src;
    json.w = stroke.w ?? 100;
    json.h = stroke.h ?? 100;
  } else if (stroke.kind === 'shape') {
    json.kind = 'shape';
    json.shape = stroke.shape === 'ellipse' ? 'ellipse' : 'rect';
    json.w = stroke.w ?? 100;
    json.h = stroke.h ?? 100;

    if (stroke.text) json.text = stroke.text;
    if (stroke.size !== undefined) json.size = stroke.size;
  } else if (stroke.kind === 'arrow') {
    json.kind = 'arrow';

    if (stroke.from) json.from = stroke.from;
    if (stroke.to) json.to = stroke.to;
    if (stroke.bend) json.bend = stroke.bend;
  }

  if (stroke.id && (stroke.kind === 'shape' || stroke.kind === 'arrow')) {
    json.id = stroke.id;
  }

  return json;
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

  const base: CanvasStroke = { color, width, path: points };

  if (obj.kind === 'text' && typeof obj.text === 'string') {
    return {
      ...base,
      kind: 'text',
      text: obj.text,
      size: typeof obj.size === 'number' ? obj.size : 24,
    };
  }

  if (obj.kind === 'image' && typeof obj.src === 'string') {
    return {
      ...base,
      kind: 'image',
      src: obj.src,
      w: typeof obj.w === 'number' ? obj.w : 100,
      h: typeof obj.h === 'number' ? obj.h : 100,
    };
  }

  const id = typeof obj.id === 'string' ? obj.id : undefined;

  if (obj.kind === 'shape') {
    return {
      ...base,
      kind: 'shape',
      shape: obj.shape === 'ellipse' ? 'ellipse' : 'rect',
      w: typeof obj.w === 'number' ? obj.w : 100,
      h: typeof obj.h === 'number' ? obj.h : 100,
      ...(typeof obj.text === 'string' && obj.text ? { text: obj.text } : {}),
      ...(typeof obj.size === 'number' ? { size: obj.size } : {}),
      ...(id ? { id } : {}),
    };
  }

  if (obj.kind === 'arrow' && points.length >= 2) {
    const bend = obj.bend;

    return {
      ...base,
      kind: 'arrow',
      path: points.slice(0, 2),
      ...(typeof obj.from === 'string' ? { from: obj.from } : {}),
      ...(typeof obj.to === 'string' ? { to: obj.to } : {}),
      ...(Array.isArray(bend) &&
      typeof bend[0] === 'number' &&
      typeof bend[1] === 'number'
        ? { bend: [bend[0], bend[1]] as [number, number] }
        : {}),
      ...(id ? { id } : {}),
    };
  }

  return base;
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
