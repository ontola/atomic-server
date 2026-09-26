// Options for `vite-plugin-prismjs`, shared by vite.config.ts and the test
// that checks its injected imports are prebundled.
export const prismjsOptions = {
  languages: ['typescript', 'json', 'diff'],
  plugins: ['diff-highlight'],
  css: true,
  theme: 'default',
};

// The modules `vite-plugin-prismjs` imports in place of `import 'prismjs'`:
// each language, the languages it builds on (typescript needs javascript,
// which needs clike) and each plugin. Vite's dep scan reads source before that
// plugin runs, so it never sees these. Without prebundling them at boot, the
// first Prism render in a dev session re-optimizes and hard-reloads the page.
// `src/vite-optimize-deps.test.ts` fails when this falls behind the options.
export const prismjsOptimizeDeps = [
  'prismjs/components/prism-core',
  'prismjs/components/prism-clike',
  'prismjs/components/prism-javascript',
  'prismjs/components/prism-typescript',
  'prismjs/components/prism-json',
  'prismjs/components/prism-diff',
  'prismjs/plugins/diff-highlight/prism-diff-highlight',
];
