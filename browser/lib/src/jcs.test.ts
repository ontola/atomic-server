import { describe, it } from 'vitest';

import { jcsCanonicalize } from './jcs.js';

describe('jcsCanonicalize (RFC 8785)', () => {
  it('sorts object keys by UTF-16 code unit', ({ expect }) => {
    expect(jcsCanonicalize({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
  });

  it('sorts nested objects and preserves array order', ({ expect }) => {
    expect(jcsCanonicalize({ z: [3, 1, 2], a: { d: 1, c: 2 } })).toBe(
      '{"a":{"c":2,"d":1},"z":[3,1,2]}',
    );
  });

  it('orders ascii before higher code points', ({ expect }) => {
    expect(jcsCanonicalize({ 'é': 1, a: 2 })).toBe('{"a":2,"é":1}');
  });

  it('serializes numbers with ECMAScript semantics', ({ expect }) => {
    expect(jcsCanonicalize(1.0)).toBe('1');
    expect(jcsCanonicalize(1.5)).toBe('1.5');
    expect(jcsCanonicalize(-0)).toBe('0');
  });

  it('escapes strings minimally like JSON.stringify', ({ expect }) => {
    expect(jcsCanonicalize('a"b\\c')).toBe('"a\\"b\\\\c"');
  });

  it('serializes primitives', ({ expect }) => {
    expect(jcsCanonicalize(null)).toBe('null');
    expect(jcsCanonicalize(true)).toBe('true');
    expect(jcsCanonicalize(false)).toBe('false');
  });

  it('rejects non-finite numbers', ({ expect }) => {
    expect(() => jcsCanonicalize(Number.NaN)).toThrow('non-finite');
    expect(() => jcsCanonicalize(Number.POSITIVE_INFINITY)).toThrow(
      'non-finite',
    );
  });
});
