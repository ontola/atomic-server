import { describe, expect, it } from 'vitest';
import type { LoroDoc } from 'loro-crdt';
import { getLoroFailure, loroCall } from './loro-context.js';

const doc = (ops: number | Error) =>
  ({
    opCount: () => {
      if (ops instanceof Error) throw ops;

      return ops;
    },
  }) as unknown as LoroDoc;

describe('loroCall', () => {
  it('returns what the call returns', () => {
    expect(loroCall('export', doc(1), () => 'bytes')).toBe('bytes');
  });

  it('rethrows the same error and notes what was running', () => {
    const trap = new Error('unreachable');

    expect(() =>
      loroCall(
        'import',
        doc(7),
        () => {
          throw trap;
        },
        1234,
      ),
    ).toThrow(trap);
    expect(getLoroFailure(trap)).toEqual({ op: 'import', bytes: 1234, ops: 7 });
    // Hidden from anything that serializes the error.
    expect(Object.keys(trap)).toEqual([]);
    expect(JSON.stringify(trap)).toBe('{}');
  });

  it('keeps the innermost note and finds it through a cause', () => {
    const inner = new Error('trap');
    const outer = new Error('wrapped', { cause: inner });

    for (const op of ['import', 'export'])
      try {
        loroCall(op, doc(1), () => {
          throw inner;
        });
      } catch {
        // expected
      }

    expect(getLoroFailure(outer)?.op).toBe('import');
  });

  it('still notes the failure when the doc cannot answer', () => {
    const trap = new Error('trap');

    expect(() =>
      loroCall('export', doc(new Error('trapped again')), () => {
        throw trap;
      }),
    ).toThrow(trap);
    expect(getLoroFailure(trap)).toEqual({ op: 'export' });
  });

  it('lets thrown strings and frozen errors through untouched', () => {
    expect(() =>
      loroCall('import', doc(1), () => {
        throw 'plain';
      }),
    ).toThrow('plain');

    const frozen = Object.freeze(new Error('frozen'));

    expect(() =>
      loroCall('import', doc(1), () => {
        throw frozen;
      }),
    ).toThrow(frozen);
    expect(getLoroFailure(frozen)).toBeUndefined();
  });
});
