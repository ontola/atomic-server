import { defineConfig } from 'vite';
import path from 'node:path';

export default defineConfig({
  test: {
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
