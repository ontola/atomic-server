// @wc-ignore-file
import { expect, it } from 'vitest';
import {
  readFileSync,
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import ts from 'typescript';

const require = createRequire(import.meta.url);
const { getManifest } = createRequire(require.resolve('vite-plugin-pwa'))(
  'workbox-build',
);

function cachePatterns(): Record<string, string[]> {
  const filename = path.resolve(__dirname, '../vite.config.ts');
  const source = ts.createSourceFile(
    filename,
    readFileSync(filename, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
  );
  let options: ts.ObjectLiteralExpression | undefined;

  function visit(node: ts.Node) {
    if (
      ts.isPropertyAssignment(node) &&
      node.name.getText(source) === 'workbox' &&
      ts.isObjectLiteralExpression(node.initializer)
    )
      options = node.initializer;
    ts.forEachChild(node, visit);
  }

  visit(source);
  expect(options).toBeDefined();
  const result: Record<string, string[]> = {};

  for (const property of options!.properties) {
    if (!ts.isPropertyAssignment(property)) continue;
    const name = property.name.getText(source);
    if (!['globPatterns', 'globIgnores'].includes(name)) continue;
    expect(ts.isArrayLiteralExpression(property.initializer)).toBe(true);
    const values = (property.initializer as ts.ArrayLiteralExpression).elements;
    result[name] = values.map(value => {
      expect(ts.isStringLiteral(value)).toBe(true);

      return (value as ts.StringLiteral).text;
    });
  }

  return result;
}

it('precaches bundled fonts and the existing JS/WASM/CSS/HTML assets while retaining exclusions', async () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'atomic-pwa-assets-'));
  const expected = [
    'assets/app.js',
    'assets/renderer.wasm',
    'assets/style.css',
    'shell.html',
    'assets/text.woff',
    'assets/text.woff2',
  ];

  try {
    for (const file of [
      ...expected,
      'index.html',
      'wasm/atomic.wasm',
      'assets/private.txt',
    ]) {
      const destination = path.join(directory, file);
      mkdirSync(path.dirname(destination), { recursive: true });
      writeFileSync(destination, 'fixture ' + file);
    }

    // Feed the shipped config's literal patterns to the actual Workbox tool.
    // Omitting globPatterns uses its real defaults, reproducing the font gap.
    const result = await getManifest({
      globDirectory: directory,
      ...cachePatterns(),
    });
    expect(
      result.manifestEntries.map((entry: { url: string }) => entry.url).sort(),
    ).toEqual(expected.sort());
    expect(result.warnings).toEqual([]);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
