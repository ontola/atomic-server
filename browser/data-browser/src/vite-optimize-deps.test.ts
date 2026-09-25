import { describe, expect, it } from 'vitest';
import prismjs from 'vite-plugin-prismjs';
import type { UserConfig } from 'vite';
import viteConfig from '../vite.config';
import { prismjsOptions } from '../prismDeps';

// Vite's dev dep optimizer only prebundles what its boot scan sees. A bare
// import it first meets at runtime makes it re-optimize and hard-reload the
// page (`optimized dependencies changed. reloading`), which threw away the
// row dialog in #1793. These tests pin the imports the scan cannot see.

async function optimizeDepsInclude(): Promise<string[]> {
  const config = (
    viteConfig as unknown as (env: {
      mode: string;
      command: string;
    }) => UserConfig
  )({ mode: 'development', command: 'serve' });

  return config.optimizeDeps?.include ?? [];
}

/** The bare imports `vite-plugin-prismjs` writes in place of `import 'prismjs'`. */
function prismImports(): string[] {
  const plugin = prismjs(prismjsOptions) as {
    transform: (code: string, id: string) => { code: string } | undefined;
  };

  const result = plugin.transform(
    "import Prism from 'prismjs';\nPrism.highlightAll();\n",
    '/src/Highlight.tsx',
  );

  const sources = [
    ...(result?.code ?? '').matchAll(/(?:from\s+|import\s+)['"]([^'"]+)['"]/g),
  ].map(match => match[1]);

  // The plugin also imports theme/plugin CSS; the optimizer ignores those.
  return sources.filter(source => !source.endsWith('.css'));
}

describe('vite optimizeDeps', () => {
  // The scan reads source before plugins transform it, so it only ever sees
  // `prismjs`. The per-language modules appear when the JSON datatype first
  // renders a value (after Save in the row dialog), which reloaded the page.
  it('prebundles every prismjs module vite-plugin-prismjs injects', async () => {
    const imports = prismImports();
    expect(imports).toContain('prismjs/components/prism-json');

    const include = await optimizeDepsInclude();
    expect(imports.filter(source => !include.includes(source))).toEqual([]);
  });

  // `entries` makes a fresh scan find the lazy JSON editor, but Vite leaves
  // `entries` out of its dep-cache hash, so an older `.vite/deps` without these
  // is reused as is. Opening the JSON editor then reloaded the page (#1793).
  it('prebundles the lazy JSON editor', async () => {
    const include = await optimizeDepsInclude();

    for (const dep of [
      '@uiw/react-codemirror',
      '@uiw/codemirror-theme-github',
      '@codemirror/lang-json',
      '@codemirror/lint',
      'codemirror-json-schema',
    ]) {
      expect(include).toContain(dep);
    }
  });
});
