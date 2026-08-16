import { describe, it } from 'vitest';
import { orderChildren, type ChildSortEntry } from './child-order.js';

/**
 * A table created in the sidebar rendered FIRST rather than last, which reads
 * as the resource having gone missing when you look for it at the bottom of a
 * list whose shape you know. It had neither `sortOrder` nor `createdAt`, so it
 * fell back to its array index — 3 against timestamps around 1.7e12.
 */

const at = (
  subject: string,
  key: number | undefined,
  index: number,
): ChildSortEntry => ({
  subject,
  key,
  index,
});

// Real values from the drive where this was found.
const HEY_WERELD = 1786819135632;
const HOUSEPLANTS = 1786870649083;
const SYNC_PROBE = 1786878205251;

describe('children with no sort key stay where the server put them', () => {
  it('does not float a keyless resource to the top', ({ expect }) => {
    const order = orderChildren([
      at('hey-wereld', HEY_WERELD, 0),
      at('houseplants', HOUSEPLANTS, 1),
      at('relay-table', undefined, 2),
      at('sync-probe', SYNC_PROBE, 3),
    ]);

    expect(order[0]).toBe('hey-wereld');
    expect(order).toEqual([
      'hey-wereld',
      'houseplants',
      'relay-table',
      'sync-probe',
    ]);
  });

  it('keeps several keyless members in server order', ({ expect }) => {
    const order = orderChildren([
      at('a', HEY_WERELD, 0),
      at('b', undefined, 1),
      at('c', undefined, 2),
      at('d', HOUSEPLANTS, 3),
    ]);

    expect(order).toEqual(['a', 'b', 'c', 'd']);
  });

  it('leaves keyless members at the front when the server put them there', ({
    expect,
  }) => {
    const order = orderChildren([
      at('first', undefined, 0),
      at('second', HEY_WERELD, 1),
      at('third', HOUSEPLANTS, 2),
    ]);

    expect(order).toEqual(['first', 'second', 'third']);
  });

  it('still honours an explicit sortOrder against createdAt neighbours', ({
    expect,
  }) => {
    // What a drag-and-drop writes: a fractional key between two neighbours,
    // which is why the two properties share a number space.
    const between = (HEY_WERELD + HOUSEPLANTS) / 2;
    const order = orderChildren([
      at('hey-wereld', HEY_WERELD, 0),
      at('houseplants', HOUSEPLANTS, 1),
      at('dragged', between, 2),
    ]);

    expect(order).toEqual(['hey-wereld', 'dragged', 'houseplants']);
  });

  it('orders a list where nothing has a key by server position', ({
    expect,
  }) => {
    const order = orderChildren([
      at('x', undefined, 0),
      at('y', undefined, 1),
      at('z', undefined, 2),
    ]);

    expect(order).toEqual(['x', 'y', 'z']);
  });
});
