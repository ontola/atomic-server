// @wc-ignore-file
import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { plural } from './plural';

const localesDir = new URL('../locales/', import.meta.url);
const english = ['1 Change', '# Changes'];

/** The rule exactly as wuchale compiles it into `export let p = n => <rule>`. */
function compiledRule(po: string): (n: number) => number {
  const body = /Plural-Forms:.*?plural=(.*?);\\n/.exec(po)?.[1] ?? '';

  return new Function('n', `return ${body}`) as (n: number) => number;
}

describe('plural', () => {
  it.each(readdirSync(localesDir).filter(f => f.endsWith('.po')))(
    'picks a candidate with the rule of %s',
    file => {
      const rule = compiledRule(
        readFileSync(new URL(file, localesDir), 'utf8'),
      );

      for (const n of [0, 1, 2, 5, 21, 100]) {
        expect(plural(n, english, rule), `n=${n}`).toMatch(/Change/);
      }
    },
  );

  it('uses a rule that returns a boolean, like gettext (n != 1)', () => {
    expect(plural(1, english, n => (n !== 1) as unknown as number)).toBe(
      '1 Change',
    );
    expect(plural(3, english, n => (n !== 1) as unknown as number)).toBe(
      '3 Changes',
    );
  });

  it('does not crash on a catalog with fewer forms than the rule picks', () => {
    expect(plural(2, ['# perubahan'])).toBe('2 perubahan');
  });

  it('does not crash on an empty catalog entry (no catalog loaded)', () => {
    expect(plural(2, [])).toBe('');
  });
});
