import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Every `var(--x)` in the app resolves to something that is actually declared.
 *
 * This is the feedback loop the token layer needs and TypeScript cannot give:
 * a custom property is a string wherever it appears, so `var(--color-bgg)`
 * typechecks, lints, renders — and silently does nothing. The value just
 * doesn't apply and the element keeps whatever it inherited.
 *
 * It is not a regression introduced by moving off the theme object. The theme
 * only ever type-checked *its own member names*; the moment a value reached an
 * inline style, a plain CSS file, or a `--local-var` inside a styled block, it
 * was an unchecked string. That is exactly where the first bug this test found
 * was living: `var(--color-bg1)` in `SearchOverlay`'s inline style — a token
 * that has never existed (it is `--color-bg-subtle`) — so the selected search
 * result had no highlight at all.
 *
 * So this checks more than the theme did: all 164 custom properties the app
 * references, including component-local ones and the plugin contract, not just
 * the couple of dozen that used to hang off `DefaultTheme`.
 */

const stylesDir = fileURLToPath(new URL('.', import.meta.url));
const srcDir = join(stylesDir, '..');

/**
 * Properties defined by something other than us. A `var()` for one of these is
 * correct even though nothing in `src/` declares it.
 */
const EXTERNAL = [
  // Radix UI writes these onto its own popper elements.
  /^--radix-/,
  // Set by `useKeyboardInset` on the document element.
  '--keyboard-inset',
];

/**
 * Comments, so prose about a token (`var(--token)` in a doc block) is not read
 * as a reference. Line comments are only stripped when they start a line, so a
 * `https://` inside a template literal survives.
 */
function stripComments(content: string): string {
  return content
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^[ \t]*\/\/.*$/gm, '');
}

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap(entry => {
    const full = join(dir, entry);

    if (statSync(full).isDirectory()) {
      return entry === 'locales' ? [] : sourceFiles(full);
    }

    return /\.(ts|tsx|css)$/.test(entry) && !entry.endsWith('.test.ts')
      ? [full]
      : [];
  });
}

const files = sourceFiles(srcDir);

const declared = new Set<string>();
const referenced = new Map<string, string>();

for (const file of files) {
  const content = stripComments(readFileSync(file, 'utf-8'));

  // `--x: value` in CSS or inside a styled template, and `'--x': value` as an
  // object key (how the plugin stylesheet builds its `--t-*` contract).
  for (const [, name] of content.matchAll(/(--[\w-]+)\s*['"`]?\s*\]?\s*:/g)) {
    declared.add(name!);
  }

  // A family of properties built by interpolation, e.g. `--cell-width-${i}`.
  // The prefix is what both sides can be compared on.
  for (const [, name] of content.matchAll(/(--[\w-]+)\$\{/g)) {
    declared.add(name!);
  }

  // A `CSSVar` instance declares its property through `.define()`, and its
  // real name carries a random suffix, so the literal never appears. Registering
  // the constructor argument keeps those out of the referenced set too — they
  // are only ever read back through `.var()`.
  for (const [, name] of content.matchAll(/new CSSVar\(\s*['"]([\w-]+)['"]/g)) {
    declared.add('--' + name!);
  }

  // Only `var()` with no fallback. `var(--x, 0)` states what to do when the
  // property is absent, so an undeclared name there is a deliberate optional
  // hook rather than a typo.
  for (const [, name, next] of content.matchAll(
    /var\(\s*(--[\w-]+)\s*([,)])/g,
  )) {
    if (next === ',') continue;

    if (!referenced.has(name!)) {
      referenced.set(name!, file.slice(srcDir.length + 1));
    }
  }
}

const isExternal = (name: string) =>
  EXTERNAL.some(rule =>
    typeof rule === 'string' ? rule === name : rule.test(name),
  );

describe('custom properties', () => {
  it('finds the token layer and a representative sample of source', () => {
    // Guards against the walker silently matching nothing and the suite
    // passing because it checked zero files.
    expect(declared.has('--color-bg')).toBe(true);
    expect(declared.has('--space-3')).toBe(true);
    expect(referenced.size).toBeGreaterThan(100);
  });

  it('every referenced property is declared somewhere', () => {
    const undeclared = [...referenced]
      .filter(([name]) => !declared.has(name) && !isExternal(name))
      .map(([name, file]) => `${name} (first seen in ${file})`)
      .sort();

    expect(undeclared).toEqual([]);
  });
});
