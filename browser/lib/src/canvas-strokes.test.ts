import { describe, it } from 'vitest';
import { parseCanvasStrokes, strokeToJson } from './canvas-strokes.js';
import { canvas } from './ontologies/canvas.js';

describe('canvas-strokes', () => {
  it('parses stroke array from resource property', ({ expect }) => {
    const raw = [
      {
        color: 0xff000000,
        width: 10,
        path: [
          [0, 0],
          [10, 20],
        ],
      },
    ];
    const strokes = parseCanvasStrokes(raw);
    expect(strokes).toHaveLength(1);
    expect(strokes[0].width).toBe(10);
    expect(strokes[0].path).toHaveLength(2);
  });

  it('parses legacy JSON string strokeData', ({ expect }) => {
    const json = JSON.stringify([{ color: 1, width: 2, path: [[1, 2]] }]);
    expect(parseCanvasStrokes(json)).toHaveLength(1);
  });

  it('round-trips strokeToJson', ({ expect }) => {
    const stroke = {
      color: 0xff123456,
      width: 5,
      path: [
        [1, 2],
        [3, 4],
      ] as [number, number][],
    };
    const json = strokeToJson(stroke);
    expect(parseCanvasStrokes([json])[0]).toEqual(stroke);
  });

  it('exports canvas ontology URLs', ({ expect }) => {
    expect(canvas.properties.strokeData).toContain('strokeData');
    expect(canvas.classes.canvas).toContain('Canvas');
  });
});
