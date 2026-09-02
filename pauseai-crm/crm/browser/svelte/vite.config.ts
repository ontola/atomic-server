import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [sveltekit()],
  build: {
    rollupOptions: {
      external: ['loro-crdt'],
    },
  },
  test: {
    include: ['src/**/*.{test,spec}.{js,ts}'],
  },
  server: {
    allowedHosts: ['t-1sk9qbdw.tunn.dev'],
    port: 5175,
  },
});
