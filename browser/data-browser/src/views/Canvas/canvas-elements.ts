import type { CanvasStroke } from '@tomic/lib';
import {
  curvePoints,
  distanceToCurve,
  pointInShape,
  resolveArrows,
  type Pt,
} from './canvas-connectors';

export type Bounds = { minX: number; minY: number; maxX: number; maxY: number };

/** Line height of text elements, as a multiple of the font size. */
export const TEXT_LINE_HEIGHT = 1.25;
export const TEXT_FONT_FAMILY = 'system-ui, -apple-system, sans-serif';

let measureCtx: CanvasRenderingContext2D | null = null;

function textWidth(text: string, size: number): number {
  measureCtx ??= document.createElement('canvas').getContext('2d');

  if (!measureCtx) {
    return text.length * size * 0.55;
  }

  measureCtx.font = `${size}px ${TEXT_FONT_FAMILY}`;

  return measureCtx.measureText(text).width;
}

/** Smallest font size text in a shape shrinks to. */
const SHAPE_MIN_FONT = 6;

/** The room text has inside a shape: the inscribed box for an ellipse. */
export function shapeTextBox(el: CanvasStroke): { w: number; h: number } {
  const w = el.w ?? 0;
  const h = el.h ?? 0;

  if (el.shape === 'ellipse') return { w: w * 0.7, h: h * 0.7 };

  const pad = 8 + Math.min(w, h) * 0.05;

  return { w: Math.max(1, w - pad * 2), h: Math.max(1, h - pad * 2) };
}

/**
 * Lay the text of a shape out: wrapped to the room inside the shape, the font
 * shrinking from its set size until everything fits (down to a minimum).
 * `measure` is injectable so the layout can be tested without a canvas.
 */
export function layoutShapeText(
  el: CanvasStroke,
  measure: (text: string, size: number) => number = textWidth,
): { size: number; lines: string[] } {
  const box = shapeTextBox(el);
  const text = el.text ?? '';
  let size = el.size ?? 20;

  const wrap = (fontSize: number): string[] => {
    const lines: string[] = [];

    for (const paragraph of text.split('\n')) {
      let line = '';

      for (const word of paragraph.split(' ')) {
        const next = line ? `${line} ${word}` : word;

        if (line && measure(next, fontSize) > box.w) {
          lines.push(line);
          line = word;
        } else {
          line = next;
        }
      }

      lines.push(line);
    }

    return lines;
  };

  for (;;) {
    const lines = wrap(size);
    const fits =
      lines.length * size * TEXT_LINE_HEIGHT <= box.h &&
      lines.every(line => measure(line, size) <= box.w);

    if (fits || size <= SHAPE_MIN_FONT) return { size, lines };

    size = Math.max(SHAPE_MIN_FONT, size * 0.92);
  }
}

/** Axis-aligned bounds of an element in canvas coordinates. */
export function elementBounds(el: CanvasStroke): Bounds {
  const [ax, ay] = el.path[0];

  if (el.kind === 'image') {
    return {
      minX: ax,
      minY: ay,
      maxX: ax + (el.w ?? 0),
      maxY: ay + (el.h ?? 0),
    };
  }

  if (el.kind === 'shape') {
    const pad = el.width / 2;

    return {
      minX: ax - pad,
      minY: ay - pad,
      maxX: ax + (el.w ?? 0) + pad,
      maxY: ay + (el.h ?? 0) + pad,
    };
  }

  if (el.kind === 'arrow' && el.path.length >= 2) {
    return pathBounds(curvePoints(el.path[0], el.path[1], el.bend), el.width);
  }

  if (el.kind === 'text') {
    const size = el.size ?? 24;
    const lines = (el.text ?? '').split('\n');
    const width = Math.max(
      size * 0.5,
      ...lines.map(line => textWidth(line, size)),
    );

    return {
      minX: ax,
      minY: ay,
      maxX: ax + width,
      maxY: ay + lines.length * size * TEXT_LINE_HEIGHT,
    };
  }

  return pathBounds(el.path, el.width);
}

function pathBounds(path: Pt[], width: number): Bounds {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;

  for (const [x, y] of path) {
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
  }

  const pad = width / 2;

  return {
    minX: minX - pad,
    minY: minY - pad,
    maxX: maxX + pad,
    maxY: maxY + pad,
  };
}

/**
 * Whether a point is on an element, `reach` canvas units of slack included
 * (text and images are hit by their box alone). Arrows must be routed first.
 */
export function hitElement(
  el: CanvasStroke,
  x: number,
  y: number,
  reach: number,
): boolean {
  if (el.kind === 'shape') return pointInShape(el, x, y, reach);

  if (el.kind === 'arrow') {
    return (
      distanceToCurve(el.path[0], el.path[1], el.bend, x, y) <
      reach + el.width / 2
    );
  }

  if (el.kind) {
    const b = elementBounds(el);

    return x >= b.minX && x <= b.maxX && y >= b.minY && y <= b.maxY;
  }

  const radius = reach + el.width / 2;

  return el.path.some(([px, py]) => Math.hypot(x - px, y - py) < radius);
}

export function unionBounds(list: Bounds[]): Bounds | null {
  if (list.length === 0) return null;

  return list.reduce((a, b) => ({
    minX: Math.min(a.minX, b.minX),
    minY: Math.min(a.minY, b.minY),
    maxX: Math.max(a.maxX, b.maxX),
    maxY: Math.max(a.maxY, b.maxY),
  }));
}

/** Bounds of everything on the canvas (strokes, text and images), or null when empty. */
export function contentBounds(elements: CanvasStroke[]): Bounds | null {
  return unionBounds(
    resolveArrows(elements)
      .filter(el => el.path.length > 0)
      .map(elementBounds),
  );
}

/** Ray-casting point-in-polygon test. */
export function pointInPolygon(
  x: number,
  y: number,
  polygon: [number, number][],
): boolean {
  let inside = false;

  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const [xi, yi] = polygon[i];
    const [xj, yj] = polygon[j];

    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) {
      inside = !inside;
    }
  }

  return inside;
}

/**
 * Whether the lasso picks an element: any point of a stroke inside the loop,
 * or, for text and images, the centre or any corner of its box.
 */
export function lassoHits(
  polygon: [number, number][],
  el: CanvasStroke,
): boolean {
  if (polygon.length < 3) return false;

  if (el.kind === 'arrow') {
    return curvePoints(el.path[0], el.path[1], el.bend).some(([x, y]) =>
      pointInPolygon(x, y, polygon),
    );
  }

  if (el.kind) {
    const b = elementBounds(el);
    const probes: [number, number][] = [
      [(b.minX + b.maxX) / 2, (b.minY + b.maxY) / 2],
      [b.minX, b.minY],
      [b.maxX, b.minY],
      [b.minX, b.maxY],
      [b.maxX, b.maxY],
    ];

    return probes.some(([x, y]) => pointInPolygon(x, y, polygon));
  }

  return el.path.some(([x, y]) => pointInPolygon(x, y, polygon));
}

/**
 * Indices of the elements the lasso loop encloses. An arrow bound to a shape
 * is picked with it, or when it lies wholly inside; one that merely brushes
 * the loop stays out, so that moving a block does not tear the arrow from the
 * block at its other end.
 */
export function lassoSelect(
  polygon: [number, number][],
  elements: CanvasStroke[],
): number[] {
  const placed = resolveArrows(elements);
  const picked = new Set<number>();

  placed.forEach((el, i) => {
    if (el.kind !== 'arrow' && lassoHits(polygon, el)) picked.add(i);
  });

  const shapeIds = new Set([...picked].map(i => placed[i].id));

  placed.forEach((el, i) => {
    if (el.kind !== 'arrow') return;

    const bound = [el.from, el.to].filter(Boolean);

    if (bound.length === 0) {
      if (lassoHits(polygon, el)) picked.add(i);

      return;
    }

    const inside =
      polygon.length >= 3 &&
      curvePoints(el.path[0], el.path[1], el.bend).every(([x, y]) =>
        pointInPolygon(x, y, polygon),
      );

    if (inside || bound.every(id => shapeIds.has(id))) picked.add(i);
  });

  return [...picked].sort((a, b) => a - b);
}

/**
 * Scale an element by `factor` around `(ox, oy)`, then move it by `(dx, dy)`.
 * Pure: returns a new element.
 */
export function transformElement(
  el: CanvasStroke,
  factor: number,
  ox: number,
  oy: number,
  dx: number,
  dy: number,
): CanvasStroke {
  const map = ([x, y]: [number, number]): [number, number] => [
    ox + (x - ox) * factor + dx,
    oy + (y - oy) * factor + dy,
  ];

  if (el.kind === 'shape') {
    return {
      ...el,
      path: [map(el.path[0])],
      w: (el.w ?? 0) * factor,
      h: (el.h ?? 0) * factor,
      width: el.width * factor,
      ...(el.size ? { size: el.size * factor } : {}),
    };
  }

  if (el.kind === 'arrow') {
    return {
      ...el,
      path: el.path.map(map),
      width: el.width * factor,
      ...(el.bend
        ? { bend: [el.bend[0] * factor, el.bend[1] * factor] as Pt }
        : {}),
    };
  }

  if (el.kind === 'text') {
    return { ...el, path: [map(el.path[0])], size: (el.size ?? 24) * factor };
  }

  if (el.kind === 'image') {
    return {
      ...el,
      path: [map(el.path[0])],
      w: (el.w ?? 0) * factor,
      h: (el.h ?? 0) * factor,
    };
  }

  return { ...el, path: el.path.map(map), width: el.width * factor };
}

/** Apply one transform to the selected indices of a list. */
export function transformSelection(
  elements: CanvasStroke[],
  selection: number[],
  factor: number,
  ox: number,
  oy: number,
  dx: number,
  dy: number,
): CanvasStroke[] {
  const picked = new Set(selection);
  // Arrows move from where they are drawn. One that is moved without the
  // shape it is bound to lets go of it, so the end moves with the arrow.
  const placed = selection.some(i => elements[i]?.kind === 'arrow')
    ? resolveArrows(elements)
    : elements;
  const ids = new Set(selection.map(i => elements[i]?.id));

  return elements.map((el, i) => {
    if (!picked.has(i)) return el;

    if (el.kind !== 'arrow')
      return transformElement(el, factor, ox, oy, dx, dy);

    const { from, to, ...rest } = placed[i];

    return transformElement(
      {
        ...rest,
        ...(from && ids.has(from) ? { from } : {}),
        ...(to && ids.has(to) ? { to } : {}),
      },
      factor,
      ox,
      oy,
      dx,
      dy,
    );
  });
}
