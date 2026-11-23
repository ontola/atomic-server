import { describe, expect, it } from 'vitest';
import type { CanvasStroke } from '@tomic/lib';
import {
  contentBounds,
  elementBounds,
  lassoSelect,
  pointInPolygon,
  transformSelection,
} from './canvas-elements';

const stroke = (path: [number, number][], width = 2): CanvasStroke => ({
  color: 0xff000000,
  width,
  path,
});

const square: [number, number][] = [
  [0, 0],
  [100, 0],
  [100, 100],
  [0, 100],
];

describe('canvas-elements', () => {
  it('tests points against a polygon', () => {
    expect(pointInPolygon(50, 50, square)).toBe(true);
    expect(pointInPolygon(150, 50, square)).toBe(false);
  });

  it('lasso picks strokes with a point inside and images by their box', () => {
    const inside = stroke([
      [10, 10],
      [20, 20],
    ]);
    const outside = stroke([
      [200, 200],
      [210, 210],
    ]);
    const image: CanvasStroke = {
      ...stroke([[40, 40]], 0.01),
      kind: 'image',
      src: 'data:,',
      w: 20,
      h: 20,
    };

    expect(lassoSelect(square, [inside, outside, image])).toEqual([0, 2]);
  });

  it('scales strokes, text and images around a point and moves them', () => {
    const text: CanvasStroke = {
      ...stroke([[10, 10]], 0.01),
      kind: 'text',
      text: 'hi',
      size: 20,
    };
    const image: CanvasStroke = {
      ...stroke([[0, 0]], 0.01),
      kind: 'image',
      src: 'data:,',
      w: 10,
      h: 20,
    };
    const [s, t, i] = transformSelection(
      [
        stroke(
          [
            [10, 10],
            [20, 10],
          ],
          4,
        ),
        text,
        image,
      ],
      [0, 1, 2],
      2,
      0,
      0,
      5,
      5,
    );

    expect(s.path).toEqual([
      [25, 25],
      [45, 25],
    ]);
    expect(s.width).toBe(8);
    expect(t.path).toEqual([[25, 25]]);
    expect(t.size).toBe(40);
    expect([i.w, i.h]).toEqual([20, 40]);
  });

  it('leaves unselected elements untouched', () => {
    const a = stroke([[1, 1]]);

    expect(transformSelection([a], [], 3, 0, 0, 9, 9)[0]).toBe(a);
  });

  it('content bounds include images by their box, not just strokes', () => {
    const image: CanvasStroke = {
      ...stroke([[500, 400]], 0.01),
      kind: 'image',
      src: 'data:,',
      w: 200,
      h: 100,
    };
    const line = stroke(
      [
        [0, 0],
        [10, 10],
      ],
      0,
    );

    expect(contentBounds([line])).toEqual({
      minX: 0,
      minY: 0,
      maxX: 10,
      maxY: 10,
    });
    expect(contentBounds([line, image])).toEqual({
      minX: 0,
      minY: 0,
      maxX: 700,
      maxY: 500,
    });
    expect(contentBounds([image])).toEqual({
      minX: 500,
      minY: 400,
      maxX: 700,
      maxY: 500,
    });
    expect(contentBounds([])).toBeNull();
  });

  it('pads stroke bounds by half the width', () => {
    expect(
      elementBounds(
        stroke(
          [
            [0, 0],
            [10, 10],
          ],
          4,
        ),
      ),
    ).toEqual({
      minX: -2,
      minY: -2,
      maxX: 12,
      maxY: 12,
    });
  });
});

describe('shapes and arrows in the element helpers', () => {
  const block = (id: string, x: number, y: number): CanvasStroke => ({
    ...stroke([[x, y]], 2),
    kind: 'shape',
    shape: 'rect',
    id,
    w: 100,
    h: 60,
  });
  const link = (from: string, to: string): CanvasStroke => ({
    ...stroke(
      [
        [0, 0],
        [1, 1],
      ],
      2,
    ),
    kind: 'arrow',
    id: `${from}${to}`,
    from,
    to,
  });

  it('bounds a shape by its box and the content bounds route arrows', () => {
    const a = block('a', 0, 0);

    expect(elementBounds(a)).toEqual({
      minX: -1,
      minY: -1,
      maxX: 101,
      maxY: 61,
    });
    // The arrow's stored points (0,0)-(1,1) are stale; the shapes win.
    expect(contentBounds([a, block('b', 300, 0), link('a', 'b')])).toEqual({
      minX: -1,
      minY: -1,
      maxX: 401,
      maxY: 61,
    });
  });

  it('lasso picks shapes and the arrows between them', () => {
    const list = [block('a', 0, 0), block('b', 300, 0), link('a', 'b')];

    expect(
      lassoSelect(
        [
          [-10, -10],
          [500, -10],
          [500, 100],
          [-10, 100],
        ],
        list,
      ),
    ).toEqual([0, 1, 2]);
    expect(
      lassoSelect(
        [
          [-10, -10],
          [60, -10],
          [60, 100],
          [-10, 100],
        ],
        list,
      ),
    ).toEqual([0]);
  });

  it('moves a shape and scales its size and text', () => {
    const a = { ...block('a', 10, 10), text: 'x', size: 20 };
    const [moved] = transformSelection([a], [0], 2, 0, 0, 5, 5);

    expect(moved.path).toEqual([[25, 25]]);
    expect([moved.w, moved.h, moved.size, moved.id]).toEqual([
      200,
      120,
      40,
      'a',
    ]);
  });

  it('an arrow moved with its shapes stays bound, alone it lets go', () => {
    const list = [block('a', 0, 0), block('b', 300, 0), link('a', 'b')];
    const [, , together] = transformSelection(list, [0, 1, 2], 1, 0, 0, 10, 0);
    const [, , alone] = transformSelection(list, [2], 1, 0, 0, 10, 0);

    expect(together.from).toBe('a');
    expect(alone.from).toBeUndefined();
    expect(alone.path[0]).toEqual([110, 30]);
  });

  it('scales the bend of an arrow with the arrow', () => {
    const a = {
      ...link('a', 'b'),
      from: undefined,
      to: undefined,
      bend: [4, 8] as [number, number],
    };

    expect(transformSelection([a], [0], 2, 0, 0, 0, 0)[0].bend).toEqual([
      8, 16,
    ]);
  });
});
