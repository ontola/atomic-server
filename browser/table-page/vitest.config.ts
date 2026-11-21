import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';
const source = (path: string) => fileURLToPath(new URL(path, import.meta.url));

export default defineConfig({
  esbuild: { jsx: 'automatic' },
  resolve: {
    alias: [
      {
        find: '@tomic/lib/calendar-recurrence.js',
        replacement: source('../lib/src/calendar-recurrence.ts'),
      },
      { find: /^@tomic\/lib$/, replacement: source('../lib/src/index.ts') },
      { find: /^@tomic\/react$/, replacement: source('../react/src/index.ts') },
      { find: /^@tomic\/table$/, replacement: source('../table/src/index.ts') },
      { find: '@tomic/ui', replacement: source('../ui/src') },
      { find: '@tomic/resource-ui', replacement: source('../resource-ui/src') },
      { find: '@tomic/table-page', replacement: source('./src') },
    ],
  },
  test: {
    include: ['src/**/*.test.{ts,tsx}'],
    setupFiles: [source('../resource-ui/test/setup.ts')],
    // Preserve Atomic’s timeout for real dynamic imports on shared CI hosts.
    testTimeout: 30_000,
    maxWorkers: 2,
  },
});
