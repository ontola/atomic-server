import { defineConfig } from 'vite';

export default defineConfig({
  test: {
    include: ['tests/**/*.integration.test.ts'],
    setupFiles: ['src/test-setup.ts'],
    testTimeout: 60_000,
    // The integration tests share a single WASM runtime via NodeClientDb;
    // running files in parallel surfaces "Rust value borrowed" panics at
    // teardown. Run each file in its own fresh fork (a new process) so the
    // WASM module is loaded and torn down in isolation.
    fileParallelism: false,
    pool: 'forks',
    isolate: true,
    poolOptions: {
      forks: {
        singleFork: false,
      },
    },
  },
});
