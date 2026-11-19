import { build } from 'esbuild';
import { execFileSync } from 'node:child_process';
import { rmSync } from 'node:fs';
rmSync('dist', { recursive: true, force: true });
execFileSync('pnpm', ['exec', 'tsc', '--emitDeclarationOnly'], {
  stdio: 'inherit',
});
await build({
  entryPoints: ['src/index.ts'],
  outfile: 'dist/index.js',
  bundle: true,
  packages: 'external',
  format: 'esm',
  target: 'es2022',
  jsx: 'automatic',
  sourcemap: true,
});
