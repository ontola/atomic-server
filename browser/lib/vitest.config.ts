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
    // Not the 5 s default: on a CI host running several pipelines at once,
    // ten tests that take milliseconds locally (signing a string, among them)
    // all hit 5 s together (batch #1966's first run). A test that really
    // hangs still fails; it only takes longer to say so.
    testTimeout: 20_000,
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
