/// <reference types="node" />
import { defineConfig } from 'tsup';
import * as fs from 'node:fs/promises';
import { exec } from 'node:child_process';

export default defineConfig(options => ({
  minify: !options.watch,
  entry: ['src/index.ts'],
  sourcemap: true,
  clean: true,
  format: ['esm', 'cjs'],
  target: 'es2023',
  // We need to generate the type definition files ourselves because the build in rollup dts plugin does not work with the way we use module augmentation.
  // Tsup will switch to microsoft-api-extractor in the future but they don't even support rolling up module augments at all. https://github.com/microsoft/rushstack/issues/1709
  onSuccess: async () => {
    console.log('Generating type definition files...');

    // Run the typescript compiler but only emit declaration files.
    exec('tsc --emitDeclarationOnly --declaration', (err, stdout, stderr) => {
      if (err || stderr) {
        console.error(err ?? stderr);
      }

      // We need a copy of index.d.ts for cjs builds but the actual content can be the same so we can just copy it.
      console.log('Creating index.d.cts...');
      fs.copyFile('dist/src/index.d.ts', 'dist/src/index.d.cts')
        .then(() => {
          console.log('Build Finished!');
        })
        .catch(console.error);
    });
  },
}));
