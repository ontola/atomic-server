// @wc-ignore-file
import { describe, expect, it } from 'vitest';
import { Datatype } from '@tomic/react';
import { appendStringToType } from './dataTypeMaps';

describe('appendStringToType (#1825)', () => {
  it('never makes NaN of text that is not a number', () => {
    expect(
      appendStringToType(undefined, 'a', Datatype.INTEGER),
    ).toBeUndefined();
    expect(appendStringToType(3, 'a', Datatype.INTEGER)).toBe(3);
    expect(appendStringToType(undefined, 'x', Datatype.FLOAT)).toBeUndefined();
    expect(
      appendStringToType(undefined, '12abc', Datatype.INTEGER),
    ).toBeUndefined();
  });

  it('reads whole numbers', () => {
    expect(appendStringToType(undefined, '7', Datatype.INTEGER)).toBe(7);
    expect(appendStringToType(undefined, '-42', Datatype.INTEGER)).toBe(-42);
    expect(appendStringToType(undefined, '1,5', Datatype.FLOAT)).toBe(1.5);
    expect(appendStringToType(undefined, '-.25', Datatype.FLOAT)).toBe(-0.25);
  });

  it('stores a slug the way the slug editor does', () => {
    expect(appendStringToType(undefined, 'A', Datatype.SLUG)).toBe('a');
    expect(appendStringToType(undefined, 'My page', Datatype.SLUG)).toBe(
      'my-page',
    );
  });

  it('stores nothing for a character that is no value of the type', () => {
    for (const datatype of [
      Datatype.ATOMIC_URL,
      Datatype.RESOURCEARRAY,
      Datatype.BOOLEAN,
      Datatype.JSON,
      Datatype.DATE,
    ]) {
      expect(appendStringToType(undefined, 'a', datatype)).toBeUndefined();
    }
  });
});
