import { defineConfig } from 'vitest/config';

export default defineConfig({
  esbuild: { jsx: 'automatic' },
  test: {
    include: ['src/**/*.test.{ts,tsx}'],
    // Main CI runs this beside the other workspace suites. Bound worker fan-out
    // rather than spawning a JSDOM worker per available runner CPU.
    maxWorkers: 2,
    // Allow up to 15s per case while the package shares CI runner resources.
    testTimeout: 15_000,
  },
});
