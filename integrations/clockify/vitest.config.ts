export default {
  root: new URL('.', import.meta.url).pathname,
  resolve: {
    alias: {
      vitest: new URL(
        '../../browser/node_modules/vitest/dist/index.js',
        import.meta.url,
      ).pathname,
      // devonian is only installed under browser/data-browser's node_modules;
      // this directory has no ancestor node_modules of its own to climb to.
      // Same alias integrations/localthought/vitest.config.ts already uses.
      devonian: new URL(
        '../../browser/data-browser/node_modules/devonian',
        import.meta.url,
      ).pathname,
      '@tomic/lib': new URL('../../browser/lib/src/index.ts', import.meta.url)
        .pathname,
    },
  },
  test: { include: ['*.test.ts'] },
};
