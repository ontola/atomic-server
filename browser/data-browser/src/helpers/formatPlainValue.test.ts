import { describe, expect, it } from 'vitest';
import { formatPlainValue } from '../helpers/formatPlainValue';

describe('formatPlainValue', () => {
  it('writes an object value out as text instead of passing it to React', () => {
    expect(
      formatPlainValue({ 'https://atomicdata.dev/task/v1/status': 'todo' }),
    ).toBe('{"https://atomicdata.dev/task/v1/status":"todo"}');
  });

  it('keeps strings, numbers and booleans readable', () => {
    expect(formatPlainValue('a')).toBe('a');
    expect(formatPlainValue(3)).toBe('3');
    expect(formatPlainValue(false)).toBe('false');
  });
});
