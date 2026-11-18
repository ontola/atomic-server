import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';

/** One self-contained browser module, including the pinned shared reader. */
export function bundleBuiltinSyncables() {
  return build({
    entryPoints: [
      fileURLToPath(
        new URL('../src/chunks/PluginRuns/builtinSyncApp.js', import.meta.url),
      ),
    ],
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: 'es2022',
    minify: true,
    write: false,
    metafile: true,
  });
}
