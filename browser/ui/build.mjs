import { build } from 'esbuild';
import { execFileSync } from 'node:child_process';
import { readdirSync, rmSync } from 'node:fs';
import path from 'node:path';
rmSync('dist', { recursive: true, force: true });
execFileSync('pnpm', ['exec', 'tsc', '--emitDeclarationOnly'], {
  stdio: 'inherit',
});
const entries = readdirSync('src', { recursive: true })
  .filter(file => /\.tsx?$/.test(file) && !/\.(test|spec)\./.test(file))
  .map(file => path.join('src', file));
await build({
  entryPoints: entries,
  outdir: 'dist',
  outbase: 'src',
  packages: 'external',
  format: 'esm',
  target: 'es2022',
  jsx: 'automatic',
  sourcemap: true,
});
