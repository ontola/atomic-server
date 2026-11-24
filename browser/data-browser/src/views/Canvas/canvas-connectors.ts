import type { CanvasStroke } from '@tomic/lib';

/**
 * Geometry for shapes and the arrows that connect them. Pure: no DOM, no
 * canvas. An arrow stores the ids of the shapes it is bound to and is routed
 * from their current bounds every time it is drawn (`resolveArrows`), so a
 * moved shape needs no commit for its arrows.
 */

export type Pt = [number, number];

/** Radius of the arrowhead's wings, in canvas units, per unit of line width. */
const ARROWHEAD_BASE = 8;
const ARROWHEAD_PER_WIDTH = 3;
const ARROWHEAD_ANGLE = 0.45;
const CURVE_SEGMENTS = 24;
/** A bend this small (canvas units) counts as straight. */
const BEND_EPSILON = 0.5;

export const isShape = (el: CanvasStroke): boolean => el.kind === 'shape';

const shapeCenter = (el: CanvasStroke): Pt => [
  el.path[0][0] + (el.w ?? 0) / 2,
  el.path[0][1] + (el.h ?? 0) / 2,
];

/**
 * Where the line from a shape's centre towards `toward` leaves its outline.
 * A rounded rectangle is treated as a plain one: the corners differ by a few
 * units at most.
 */
export function edgePoint(shape: CanvasStroke, toward: Pt): Pt {
  const [cx, cy] = shapeCenter(shape);
  const a = Math.max(1e-6, (shape.w ?? 0) / 2);
  const b = Math.max(1e-6, (shape.h ?? 0) / 2);
  let dx = toward[0] - cx;
  let dy = toward[1] - cy;

  if (Math.abs(dx) < 1e-9 && Math.abs(dy) < 1e-9) {
    dx = 1;
    dy = 0;
  }

  const t =
    shape.shape === 'ellipse'
      ? 1 / Math.hypot(dx / a, dy / b)
      : Math.min(
          a / Math.max(Math.abs(dx), 1e-9),
          b / Math.max(Math.abs(dy), 1e-9),
        );

  return [cx + dx * t, cy + dy * t];
}

/** The quadratic control point of an arrow from `p0` to `p1`. */
export const controlPoint = (p0: Pt, p1: Pt, bend: Pt | undefined): Pt => [
  (p0[0] + p1[0]) / 2 + (bend?.[0] ?? 0),
  (p0[1] + p1[1]) / 2 + (bend?.[1] ?? 0),
];

const shapesById = (list: CanvasStroke[]): Map<string, CanvasStroke> => {
  const map = new Map<string, CanvasStroke>();

  for (const el of list) {
    if (el.kind === 'shape' && el.id) map.set(el.id, el);
  }

  return map;
};

/** An arrow with its ends placed on the shapes it is bound to. */
function resolveArrow(
  arrow: CanvasStroke,
  byId: Map<string, CanvasStroke>,
): CanvasStroke {
  const a = arrow.from ? byId.get(arrow.from) : undefined;
  const b = arrow.to ? byId.get(arrow.to) : undefined;

  if (!a && !b) return arrow;

  const c0 = a ? shapeCenter(a) : arrow.path[0];
  const c1 = b ? shapeCenter(b) : arrow.path[1];
  const aim = arrow.bend ? controlPoint(c0, c1, arrow.bend) : undefined;

  return {
    ...arrow,
    path: [a ? edgePoint(a, aim ?? c1) : c0, b ? edgePoint(b, aim ?? c0) : c1],
  };
}

/**
 * The list with every arrow routed from the current bounds of its shapes.
 * Elements that need no routing keep their identity.
 */
export function resolveArrows(list: CanvasStroke[]): CanvasStroke[] {
  if (!list.some(el => el.kind === 'arrow' && (el.from || el.to))) return list;

  const byId = shapesById(list);

  return list.map(el => (el.kind === 'arrow' ? resolveArrow(el, byId) : el));
}

/** An arrow placed on its shapes, for a list that is not drawn yet. */
export function resolveArrowIn(
  arrow: CanvasStroke,
  list: CanvasStroke[],
): CanvasStroke {
  return resolveArrow(arrow, shapesById(list));
}

/** The shape under a point (topmost first), optionally skipping one id. */
export function shapeAt(
  list: CanvasStroke[],
  x: number,
  y: number,
  reach: number,
  skipId?: string,
): CanvasStroke | undefined {
  for (let i = list.length - 1; i >= 0; i--) {
    const el = list[i];

    if (el.kind === 'shape' && el.id && el.id !== skipId) {
      if (pointInShape(el, x, y, reach)) return el;
    }
  }

  return undefined;
}

/** Whether a point is inside a shape, grown by `reach`. */
export function pointInShape(
  shape: CanvasStroke,
  x: number,
  y: number,
  reach = 0,
): boolean {
  const [cx, cy] = shapeCenter(shape);
  const a = (shape.w ?? 0) / 2 + reach;
  const b = (shape.h ?? 0) / 2 + reach;

  if (a <= 0 || b <= 0) return false;

  if (shape.shape === 'ellipse') {
    return ((x - cx) / a) ** 2 + ((y - cy) / b) ** 2 <= 1;
  }

  return Math.abs(x - cx) <= a && Math.abs(y - cy) <= b;
}

/** Whether a point is within `reach` of a shape's outline, inside or out. */
export const nearShapeOutline = (
  shape: CanvasStroke,
  x: number,
  y: number,
  reach: number,
): boolean =>
  pointInShape(shape, x, y, reach) && !pointInShape(shape, x, y, -reach);

/** A point on the arrow's quadratic curve, `t` in 0..1. */
export function curvePoint(
  p0: Pt,
  p1: Pt,
  bend: Pt | undefined,
  t: number,
): Pt {
  const c = controlPoint(p0, p1, bend);
  const u = 1 - t;

  return [
    u * u * p0[0] + 2 * u * t * c[0] + t * t * p1[0],
    u * u * p0[1] + 2 * u * t * c[1] + t * t * p1[1],
  ];
}

/** The curve as a polyline (two points when it is straight). */
export function curvePoints(p0: Pt, p1: Pt, bend: Pt | undefined): Pt[] {
  if (!bend) return [p0, p1];

  return Array.from({ length: CURVE_SEGMENTS + 1 }, (_, i) =>
    curvePoint(p0, p1, bend, i / CURVE_SEGMENTS),
  );
}

/** Distance from a point to the arrow's curve. */
export function distanceToCurve(
  p0: Pt,
  p1: Pt,
  bend: Pt | undefined,
  x: number,
  y: number,
): number {
  const pts = curvePoints(p0, p1, bend);
  let best = Infinity;

  for (let i = 1; i < pts.length; i++) {
    const [ax, ay] = pts[i - 1];
    const [bx, by] = pts[i];
    const dx = bx - ax;
    const dy = by - ay;
    const len2 = dx * dx + dy * dy;
    const t =
      len2 === 0
        ? 0
        : Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / len2));

    best = Math.min(best, Math.hypot(x - (ax + t * dx), y - (ay + t * dy)));
  }

  return best;
}

/** Where the bend handle sits: the middle of the curve. */
export const handlePosition = (p0: Pt, p1: Pt, bend: Pt | undefined): Pt =>
  curvePoint(p0, p1, bend, 0.5);

/**
 * The bend that puts the curve's middle under `handle`. The curve's middle is
 * halfway between the straight midpoint and the control point. Close to
 * straight snaps to no bend.
 */
export function bendFromHandle(p0: Pt, p1: Pt, handle: Pt): Pt | undefined {
  const bend: Pt = [
    2 * (handle[0] - (p0[0] + p1[0]) / 2),
    2 * (handle[1] - (p0[1] + p1[1]) / 2),
  ];

  return Math.hypot(bend[0], bend[1]) < BEND_EPSILON ? undefined : bend;
}

/**
 * The arrow with one end (0 = start, 1 = end) dragged to `pt`. A shape under
 * the point (other than the one the other end is bound to) binds the end;
 * otherwise the end is free at `pt`. The bend turns and scales with the
 * chord, so the curve keeps its shape as an end moves.
 */
export function moveArrowEnd(
  arrow: CanvasStroke,
  end: 0 | 1,
  pt: Pt,
  list: CanvasStroke[],
  reach: number,
): CanvasStroke {
  const key = end === 0 ? 'from' : 'to';
  const otherKey = end === 0 ? 'to' : 'from';
  const [q0, q1] = resolveArrowIn(arrow, list).path;
  const target = shapeAt(list, pt[0], pt[1], reach, arrow[otherKey]);
  const { from: _f, to: _t, ...rest } = arrow;
  const moved: CanvasStroke = {
    ...rest,
    path: end === 0 ? [pt, q1] : [q0, pt],
    ...(arrow[otherKey] ? { [otherKey]: arrow[otherKey] } : {}),
    ...(target?.id ? { [key]: target.id } : {}),
  };
  const [n0, n1] = resolveArrowIn(moved, list).path;

  if (!arrow.bend) return moved;

  const vx = q1[0] - q0[0];
  const vy = q1[1] - q0[1];
  const wx = n1[0] - n0[0];
  const wy = n1[1] - n0[1];
  const len2 = vx * vx + vy * vy;

  if (len2 < 1e-9) return moved;

  // Complex ratio w / v: the rotation and scale from the old chord to the new.
  const re = (wx * vx + wy * vy) / len2;
  const im = (wy * vx - wx * vy) / len2;
  const [bx, by] = arrow.bend;

  return { ...moved, bend: [bx * re - by * im, bx * im + by * re] };
}

/** The two wing tips of the arrowhead at the end of the arrow. */
export function arrowheadPoints(
  p0: Pt,
  p1: Pt,
  bend: Pt | undefined,
  width: number,
): { tip: Pt; wings: [Pt, Pt] } {
  const from = bend ? controlPoint(p0, p1, bend) : p0;
  const back = Math.atan2(from[1] - p1[1], from[0] - p1[0]);
  const size = ARROWHEAD_BASE + width * ARROWHEAD_PER_WIDTH;
  const wing = (angle: number): Pt => [
    p1[0] + size * Math.cos(angle),
    p1[1] + size * Math.sin(angle),
  ];

  return {
    tip: p1,
    wings: [wing(back + ARROWHEAD_ANGLE), wing(back - ARROWHEAD_ANGLE)],
  };
}

/**
 * Remove elements and unbind the arrows that pointed at removed shapes: they
 * stay, with their ends where the shapes were.
 */
export function deleteElements(
  list: CanvasStroke[],
  picked: Set<number>,
): CanvasStroke[] {
  const gone = new Set<string>();

  picked.forEach(i => {
    const id = list[i]?.id;

    if (id) gone.add(id);
  });

  const placed = gone.size > 0 ? resolveArrows(list) : list;

  return list.flatMap((el, i) => {
    if (picked.has(i)) return [];

    if (
      el.kind !== 'arrow' ||
      !((el.from && gone.has(el.from)) || (el.to && gone.has(el.to)))
    ) {
      return [el];
    }

    const { from, to, ...rest } = el;

    return [
      {
        ...rest,
        path: placed[i].path,
        ...(from && !gone.has(from) ? { from } : {}),
        ...(to && !gone.has(to) ? { to } : {}),
      },
    ];
  });
}

/**
 * Copies of the elements at `indices`, moved by `(dx, dy)`, with fresh ids.
 * Arrows copied together with their shapes bind to the copies; an arrow whose
 * shape is not copied stays where it was drawn, unbound.
 */
export function duplicateElements(
  list: CanvasStroke[],
  indices: number[],
  dx: number,
  dy: number,
  newId: () => string,
): CanvasStroke[] {
  const placed = resolveArrows(list);
  const ids = new Map<string, string>();

  for (const i of indices) {
    const id = list[i]?.id;

    if (id) ids.set(id, newId());
  }

  const move = (p: Pt): Pt => [p[0] + dx, p[1] + dy];

  return indices.flatMap(i => {
    const el = placed[i];

    if (!el) return [];

    const copy: CanvasStroke = { ...el, path: el.path.map(move) };

    if (el.id) copy.id = ids.get(el.id);

    if (el.kind === 'arrow') {
      const from = el.from ? ids.get(el.from) : undefined;
      const to = el.to ? ids.get(el.to) : undefined;

      delete copy.from;
      delete copy.to;

      if (from) copy.from = from;
      if (to) copy.to = to;
    }

    return [copy];
  });
}
