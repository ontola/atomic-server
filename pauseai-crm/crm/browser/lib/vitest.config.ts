import { defineConfig } from 'vite';
import path from 'node:path';

export default defineConfig({
  test: {
    // Unit tests only. The `tests/` directory holds integration tests that
    // need a built `target/debug/atomic-server` binary (see `server-fixture.ts`)
    // and a built WASM at `wasm/pkg/`. Run those via
    // `pnpm test:integration` (vitest.integration.config.ts) — they require
    // a separate CI step that builds the Rust binary first.
    include: ['src/**/*.test.ts'],
    setupFiles: ['src/test-setup.ts'],
  },
  server: {
    port: 5175,
  },
  build: {
    lib: {
      entry: path.resolve(__dirname, 'src/index.ts'),
      fileName: 'index',
    },
    rollupOptions: {},
  },
});
