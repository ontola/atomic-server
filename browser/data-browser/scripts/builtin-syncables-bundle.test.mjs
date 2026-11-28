import { expect, it } from 'vitest';
import { bundleBuiltinSyncables } from './build-builtin-syncables.mjs';

it('ships the account chooser as a self-contained browser module using the shared bridge', async () => {
  const result = await bundleBuiltinSyncables();
  const output = Object.values(result.metafile.outputs)[0];
  expect(output.imports).toEqual([]);
  const inputs = Object.keys(output.inputs);
  expect(inputs.some(path => path.endsWith('/builtinSyncApp.ts'))).toBe(true);
  expect(inputs.some(path => path.endsWith('/viewClient.js'))).toBe(false);
  expect(inputs.some(path => path.includes('/overlays/APIs/'))).toBe(false);
  const code = result.outputFiles[0].text;
  const app = await import(
    'data:text/javascript;base64,' + Buffer.from(code).toString('base64')
  );
  expect(typeof app.view).toBe('function');
  expect(typeof app.createPrincipalChooser).toBe('function');
});
