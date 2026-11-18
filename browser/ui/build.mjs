import { build } from 'esbuild';
import { execFileSync } from 'node:child_process';
import { copyFileSync, readdirSync, rmSync } from 'node:fs';
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

// These standalone modules come from one source; neither distributed package
// requires consumers to install the private build dependency.
for (const [source, target] of [
  ['EventManager', 'helpers/EventManager'],
  ['calendar-date', 'helpers/dates/isCalendarDate'],
]) {
  for (const extension of ['js', 'd.ts']) {
    copyFileSync(
      `../utils/dist/${source}.${extension}`,
      `dist/${target}.${extension}`,
    );
  }

  rmSync(`dist/${target}.js.map`, { force: true });
}
