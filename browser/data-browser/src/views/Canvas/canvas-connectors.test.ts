import { describe, expect, it } from 'vitest';
import type { CanvasStroke } from '@tomic/lib';
import {
  arrowheadPoints,
  bendFromHandle,
  curvePoint,
  deleteElements,
  distanceToCurve,
  duplicateElements,
  edgePoint,
  handlePosition,
  moveArrowEnd,
  nearShapeOutline,
  pointInShape,
  resolveArrows,
  shapeAt,
} from './canvas-connectors';
import { elementBounds, hitElement, layoutShapeText } from './canvas-elements';

const shape = (
  id: string,
  x: number,
  y: number,
  w = 100,
  h = 60,
  kind: 'rect' | 'ellipse' = 'rect',
): CanvasStroke => ({
  color: 0xff000000,
  width: 2,
  path: [[x, y]],
  kind: 'shape',
  shape: kind,
  id,
  w,
  h,
});

const arrow = (extra: Partial<CanvasStroke> = {}): CanvasStroke => ({
  color: 0xff000000,
  width: 2,
  path: [
    [0, 0],
    [10, 10],
  ],
  kind: 'arrow',
  id: 'ar',
  ...extra,
});

describe('edgePoint', () => {
  it('leaves a rectangle through the side the target is on', () => {
    const r = shape('a', 0, 0); // centre (50, 30)

    expect(edgePoint(r, [300, 30])).toEqual([100, 30]);
    expect(edgePoint(r, [50, -200])).toEqual([50, 0]);
    // Diagonal: hits the top edge first for a wide box.
    const [x, y] = edgePoint(r, [150, -70]);

    expect(y).toBeCloseTo(0);
    expect(x).toBeCloseTo(50 + 30);
  });

  it('leaves an ellipse on its outline', () => {
    const e = shape('a', 0, 0, 100, 60, 'ellipse');

    expect(edgePoint(e, [500, 30])[0]).toBeCloseTo(100);
    const [x, y] = edgePoint(e, [150, 90]);

    expect(((x - 50) / 50) ** 2 + ((y - 30) / 30) ** 2).toBeCloseTo(1);
  });

  it('copes with a target at the centre', () => {
    expect(edgePoint(shape('a', 0, 0), [50, 30])).toEqual([100, 30]);
  });
});

describe('resolveArrows', () => {
  const a = shape('a', 0, 0);
  const b = shape('b', 300, 0);

  it('routes bound ends from the current bounds of the shapes', () => {
    const list = [a, b, arrow({ from: 'a', to: 'b' })];
    const [, , routed] = resolveArrows(list);

    expect(routed.path).toEqual([
      [100, 30],
      [300, 30],
    ]);

    // Move b: the arrow follows without being touched.
    const moved = [a, shape('b', 300, 200), list[2]];

    expect(resolveArrows(moved)[2].path[1][1]).toBeGreaterThan(30);
    expect(moved[2]).toBe(list[2]);
  });

  it('keeps a free end at its stored point', () => {
    const [, , routed] = resolveArrows([
      a,
      b,
      arrow({
        from: 'a',
        path: [
          [0, 0],
          [500, 30],
        ],
      }),
    ]);

    expect(routed.path[1]).toEqual([500, 30]);
    expect(routed.path[0]).toEqual([100, 30]);
  });

  it('falls back to the stored point when the shape is gone', () => {
    const lone = arrow({ from: 'gone' });

    expect(resolveArrows([lone])[0]).toBe(lone);
  });

  it('keeps identity when nothing is bound', () => {
    const list = [a, arrow()];

    expect(resolveArrows(list)).toBe(list);
  });
});

describe('curves', () => {
  const p0: [number, number] = [0, 0];
  const p1: [number, number] = [100, 0];

  it('the handle sits on the curve middle and round-trips the bend', () => {
    expect(handlePosition(p0, p1, undefined)).toEqual([50, 0]);

    const bend: [number, number] = [0, -80];
    const h = handlePosition(p0, p1, bend);

    expect(h).toEqual([50, -40]);
    expect(bendFromHandle(p0, p1, h)).toEqual(bend);
    expect(curvePoint(p0, p1, bend, 0.5)).toEqual(h);
  });

  it('a handle near the straight line resets the bend', () => {
    expect(bendFromHandle(p0, p1, [50, 0.1])).toBeUndefined();
  });

  it('measures the distance to a straight and a bent arrow', () => {
    expect(distanceToCurve(p0, p1, undefined, 50, 10)).toBeCloseTo(10);
    expect(distanceToCurve(p0, p1, undefined, 150, 0)).toBeCloseTo(50);
    expect(distanceToCurve(p0, p1, [0, -80], 50, -40)).toBeLessThan(0.5);
    expect(distanceToCurve(p0, p1, [0, -80], 50, 0)).toBeGreaterThan(30);
  });

  it('puts the arrowhead on the end, pointing along the tangent', () => {
    const { tip, wings } = arrowheadPoints(p0, p1, undefined, 2);

    expect(tip).toEqual(p1);
    // Wings sit behind the tip, either side of the line.
    expect(wings[0][0]).toBeLessThan(100);
    expect(wings[1][0]).toBeLessThan(100);
    expect(wings[0][1]).toBeCloseTo(-wings[1][1]);

    // With a bend upwards the head tilts to follow the curve.
    const bent = arrowheadPoints(p0, p1, [0, -80], 2);

    expect(bent.wings[0][1] + bent.wings[1][1]).toBeLessThan(0);
  });

  it('includes the curve in the bounds of a bent arrow', () => {
    const b = elementBounds(
      arrow({ path: [p0, p1], bend: [0, -80], width: 0 }),
    );

    expect(b.minY).toBeCloseTo(-40);
    expect(b.maxX).toBe(100);
  });
});

describe('shape tests', () => {
  it('knows the inside of rectangles and ellipses', () => {
    const e = shape('a', 0, 0, 100, 100, 'ellipse');

    expect(pointInShape(e, 50, 50)).toBe(true);
    expect(pointInShape(e, 2, 2)).toBe(false);
    expect(pointInShape(e, 2, 2, 20)).toBe(true);
    expect(pointInShape(shape('r', 0, 0), 2, 2)).toBe(true);
  });

  it('finds the topmost shape and can skip one', () => {
    const list = [shape('a', 0, 0), shape('b', 50, 0)];

    expect(shapeAt(list, 60, 10, 0)?.id).toBe('b');
    expect(shapeAt(list, 60, 10, 0, 'b')?.id).toBe('a');
    expect(shapeAt(list, 400, 10, 0)).toBeUndefined();
  });

  it('tells the outline from the inside', () => {
    const r = shape('a', 0, 0, 200, 100);

    expect(nearShapeOutline(r, 100, 2, 6)).toBe(true);
    expect(nearShapeOutline(r, 100, 50, 6)).toBe(false);
    expect(hitElement(r, 100, 50, 6)).toBe(true);
  });

  it('hits arrows near their curve only', () => {
    const a = arrow({
      path: [
        [0, 0],
        [100, 0],
      ],
    });

    expect(hitElement(a, 50, 5, 12)).toBe(true);
    expect(hitElement(a, 50, 40, 12)).toBe(false);
  });
});

describe('deleteElements', () => {
  it('unbinds arrows of a deleted shape and keeps them where they were', () => {
    const list = [
      shape('a', 0, 0),
      shape('b', 300, 0),
      arrow({ from: 'a', to: 'b', bend: [0, 20] }),
    ];
    const next = deleteElements(list, new Set([1]));

    expect(next).toHaveLength(2);
    expect(next[1].from).toBe('a');
    expect(next[1].to).toBeUndefined();
    expect(next[1].path[1][0]).toBeGreaterThan(200);
    expect(next[1].bend).toEqual([0, 20]);
  });

  it('removes picked arrows and leaves a plain delete alone', () => {
    const list = [shape('a', 0, 0), arrow()];

    expect(deleteElements(list, new Set([1]))).toEqual([list[0]]);
    expect(deleteElements(list, new Set())[1]).toBe(list[1]);
  });
});

describe('duplicateElements', () => {
  let n = 0;

  it('gives copies new ids and binds copied arrows to copied shapes', () => {
    const list = [
      shape('a', 0, 0),
      shape('b', 300, 0),
      arrow({ from: 'a', to: 'b' }),
    ];
    const [a2, , ar2] = duplicateElements(
      list,
      [0, 1, 2],
      10,
      20,
      () => `n${++n}`,
    );

    expect(a2.id).not.toBe('a');
    expect(a2.path[0]).toEqual([10, 20]);
    expect(ar2.from).toBe(a2.id);
    expect(ar2.to).toBeDefined();
    expect(ar2.to).not.toBe('b');
    expect(list[0].id).toBe('a');
  });

  it('unbinds an arrow whose shape is not copied, at its drawn position', () => {
    const list = [
      shape('a', 0, 0),
      shape('b', 300, 0),
      arrow({ from: 'a', to: 'b' }),
    ];
    const [ar2] = duplicateElements(list, [2], 5, 5, () => 'x');

    expect(ar2.from).toBeUndefined();
    expect(ar2.to).toBeUndefined();
    expect(ar2.path[0]).toEqual([105, 35]);
  });
});

describe('layoutShapeText', () => {
  // Every character is 10 wide at size 20, scaling with the size.
  const measure = (t: string, size: number) => t.length * (size / 2);
  const box = (text: string, w: number, h: number, size = 20) => ({
    ...shape('a', 0, 0, w, h),
    text,
    size,
  });

  it('keeps short text on one line at its size', () => {
    const { size, lines } = layoutShapeText(box('hi', 200, 100), measure);

    expect(lines).toEqual(['hi']);
    expect(size).toBe(20);
  });

  it('wraps at the room inside the shape', () => {
    const { lines } = layoutShapeText(
      box('aaaa bbbb cccc dddd', 120, 200),
      measure,
    );

    expect(lines.length).toBeGreaterThan(1);
    expect(lines.every(l => measure(l, 20) <= 104)).toBe(true);
  });

  it('shrinks text that does not fit, down to a minimum', () => {
    const long = 'word '.repeat(40).trim();
    const { size } = layoutShapeText(box(long, 100, 50), measure);

    expect(size).toBeLessThan(20);
    expect(size).toBeGreaterThanOrEqual(6);
  });

  it('keeps hard line breaks', () => {
    expect(layoutShapeText(box('a\nb', 200, 200), measure).lines).toEqual([
      'a',
      'b',
    ]);
  });
});

describe('moveArrowEnd', () => {
  const a = shape('a', 0, 0); // centre (50, 30)
  const b = shape('b', 300, 0);
  const c = shape('c', 300, 200);
  const bound = arrow({ from: 'a', to: 'b' });

  it('binds the dragged end to the block under the point', () => {
    const moved = moveArrowEnd(bound, 1, [350, 230], [a, b, c, bound], 0);

    expect(moved.to).toBe('c');
    expect(moved.from).toBe('a');
  });

  it('unbinds in empty space and keeps the free point', () => {
    const moved = moveArrowEnd(bound, 1, [600, 500], [a, b, c, bound], 0);

    expect(moved.to).toBeUndefined();
    expect(moved.from).toBe('a');
    expect(moved.path[1]).toEqual([600, 500]);
  });

  it('keeps the other end where it was drawn when it was free', () => {
    const free = arrow({
      path: [
        [20, 20],
        [200, 20],
      ],
    });
    const moved = moveArrowEnd(free, 0, [40, 90], [free], 0);

    expect(moved.path).toEqual([
      [40, 90],
      [200, 20],
    ]);
  });

  it('does not bind both ends to the same block', () => {
    const moved = moveArrowEnd(bound, 1, [50, 30], [a, b, bound], 0);

    expect(moved.to).toBeUndefined();
  });

  it('turns and scales the bend with the chord', () => {
    const free = arrow({
      path: [
        [0, 0],
        [100, 0],
      ],
      bend: [0, 40],
    });
    const moved = moveArrowEnd(free, 1, [0, 200], [free], 0);

    // Chord rotated 90 degrees and doubled: the bend does the same.
    expect(moved.bend?.[0]).toBeCloseTo(-80);
    expect(moved.bend?.[1]).toBeCloseTo(0);
  });
});
