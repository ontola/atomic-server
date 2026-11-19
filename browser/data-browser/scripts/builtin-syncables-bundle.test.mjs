import { expect, it } from 'vitest';
import { bundleBuiltinSyncables } from './build-builtin-syncables.mjs';

it('ships real shared reader code and metadata in one browser module', async () => {
  const result = await bundleBuiltinSyncables();
  const output = Object.values(result.metafile.outputs)[0];
  expect(output.imports).toEqual([]);

  for (const suffix of [
    '/build/src/read/collections.js',
    '/build/src/read/pages.js',
    '/build/src/read/model.js',
  ]) {
    const key = Object.keys(output.inputs).find(path => path.endsWith(suffix));
    expect(key, suffix).toBeDefined();
    expect(output.inputs[key].bytesInOutput).toBeGreaterThan(100);
  }

  expect(
    Object.keys(output.inputs).some(path => path.includes('/overlays/APIs/')),
  ).toBe(false);
  const code = result.outputFiles[0].text;
  const app = await import(
    'data:text/javascript;base64,' + Buffer.from(code).toString('base64')
  );
  expect(typeof app.view).toBe('function');
  expect(typeof app.createSyncApp).toBe('function');
});
