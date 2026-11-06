// @wc-ignore-file
import { describe, expect, it } from 'vitest';
import { parseInline } from './documentText';

describe('Markdown inside a line', () => {
  it('reads bold, italic, code and links', () => {
    expect(parseInline('a **b** _c_ `d` [e](https://x)')).toEqual([
      { text: 'a ', marks: {} },
      { text: 'b', marks: { bold: {} } },
      { text: ' ', marks: {} },
      { text: 'c', marks: { italic: {} } },
      { text: ' ', marks: {} },
      { text: 'd', marks: { code: {} } },
      { text: ' ', marks: {} },
      { text: 'e', marks: { link: { href: 'https://x' } } },
    ]);
  });

  it('leaves a lone asterisk or a snake_case word alone', () => {
    expect(parseInline('3 * 4 en snake_case_naam')).toEqual([
      { text: '3 * 4 en snake_case_naam', marks: {} },
    ]);
  });
});
