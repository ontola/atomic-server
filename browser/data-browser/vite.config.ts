import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';
import webfontDownload from 'vite-plugin-webfont-dl';
import prismjs from 'vite-plugin-prismjs';
import wasm from 'vite-plugin-wasm';
import { wuchale } from '@wuchale/vite-plugin';
import * as fs from 'node:fs';
import * as path from 'node:path';

const repoLibDefaults = path.resolve(__dirname, '../../lib/defaults');
const ciLibDefaults = path.resolve(__dirname, '../lib-defaults');
const libDefaultsDir = fs.existsSync(
  path.join(repoLibDefaults, 'default_base_models.json'),
)
  ? repoLibDefaults
  : ciLibDefaults;

export default defineConfig({
  resolve: {
    alias: {
      '@components': path.resolve(__dirname, 'src/components'),
      '@views': path.resolve(__dirname, 'src/views'),
      '@hooks': path.resolve(__dirname, 'src/hooks'),
      '@helpers': path.resolve(__dirname, 'src/helpers'),
      '@chunks': path.resolve(__dirname, 'src/chunks'),
      '@repo-lib-defaults': libDefaultsDir,
    },
  },
  plugins: [
    wasm(),
    webfontDownload(),
    wuchale(),
    react({
      babel: {
        plugins: [
          [
            'babel-plugin-styled-components',
            { displayName: true, fileName: false },
          ],
        ],
      },
    }),
    VitePWA({
      registerType: 'autoUpdate',
      injectRegister: 'auto',
      manifest: {
        name: 'Atomic Data Browser',
        short_name: 'Atomic',
        description:
          'The easiest way to create, share and model Linked Atomic Data.',
        theme_color: '#ffffff',
        icons: [
          {
            src: 'app_data/images/android-chrome-192x192.png',
            sizes: '192x192',
            type: 'image/png',
            purpose: 'any',
          },
          {
            src: 'app_data/images/android-chrome-512x512.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'any',
          },
          {
            src: 'app_data/images/maskable_icon.png',
            sizes: '1024x1024',
            type: 'image/png',
            purpose: 'maskable',
          },
          {
            src: 'app_data/images/maskable_icon_x512.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'maskable',
          },
          {
            src: 'app_data/images/maskable_icon_x384.png',
            sizes: '384x384',
            type: 'image/png',
            purpose: 'maskable',
          },
          {
            src: 'app_data/images/maskable_icon_x192.png',
            sizes: '192x192',
            type: 'image/png',
            purpose: 'maskable',
          },
          {
            src: 'app_data/images/maskable_icon_x128.png',
            sizes: '128x128',
            type: 'image/png',
            purpose: 'maskable',
          },
        ],
      },
      workbox: {
        // See https://github.com/atomicdata-dev/atomic-data-browser/issues/294
        // index.html is excluded from precaching because atomic-server injects
        // CSP nonces dynamically. Instead we use runtime caching with NetworkFirst
        // so the SW caches whatever HTML the server serves (with nonce), and falls
        // back to it offline.
        globIgnores: ['**/index.html'],
        // Increased for WASM binaries (loro-crdt + atomic-wasm)
        maximumFileSizeToCacheInBytes: 10 * 1024 * 1024,
        // index.html is NOT precached because atomic-server injects CSP nonces.
        // Disable the default navigateFallback (which requires precached index.html).
        // Instead we cache navigation responses at runtime with NetworkFirst.
        navigateFallback: null,
        runtimeCaching: [
          {
            // Cache ALL navigation requests (SPA — same HTML shell for all routes).
            // NetworkFirst: use server when online, fall back to cache offline.
            urlPattern: ({ request }) => request.mode === 'navigate',
            handler: 'NetworkFirst',
            options: {
              cacheName: 'html-cache',
              expiration: {
                maxEntries: 10,
                maxAgeSeconds: 60 * 60 * 24 * 7, // 7 days
              },
              cacheableResponse: {
                statuses: [200],
              },
            },
          },
          {
            // Cache WASM and worker files
            urlPattern: /\/wasm\/.*/i,
            handler: 'CacheFirst',
            options: {
              cacheName: 'wasm-cache',
              expiration: {
                maxEntries: 10,
                maxAgeSeconds: 60 * 60 * 24 * 30, // 30 days
              },
              cacheableResponse: {
                statuses: [0, 200],
              },
            },
          },
          {
            urlPattern: /^https:\/\/fonts\.googleapis\.com\/.*/i,
            handler: 'CacheFirst',
            options: {
              cacheName: 'google-fonts-cache',
              expiration: {
                maxEntries: 10,
                maxAgeSeconds: 60 * 60 * 24 * 365, // <== 365 days
              },
              cacheableResponse: {
                statuses: [0, 200],
              },
            },
          },
          {
            urlPattern:
              /^https?:\/\/.*\.(?:png|jpg|jpeg|gif|bmp|svg|webp|ico)/i,
            handler: 'CacheFirst',
            options: {
              cacheName: 'images-cache',
              expiration: {
                maxEntries: 100,
                maxAgeSeconds: 60 * 60 * 24 * 30, // <== 30 days
              },
              cacheableResponse: {
                statuses: [0, 200],
              },
            },
          },
          {
            urlPattern: /^https:\/\/fonts\.gstatic\.com\/.*/i,
            handler: 'CacheFirst',
            options: {
              cacheName: 'gstatic-fonts-cache',
              expiration: {
                maxEntries: 10,
                maxAgeSeconds: 60 * 60 * 24 * 365, // <== 365 days
              },
              cacheableResponse: {
                statuses: [0, 200],
              },
            },
          },
        ],
      },
    }),
    prismjs({
      languages: ['typescript'],
      css: true,
      theme: 'default',
    }),
  ],
  optimizeDeps: {
    // this may help when linking + HMR is not working
    // exclude: ['@tomic/lib', '@tomic/react'],
  },
  build: {
    target: 'baseline-widely-available',
    sourcemap: true,
    rollupOptions: {
      output: {
        entryFileNames: `assets/[name]-[hash].js`,
        chunkFileNames: `assets/chunk_[name]-[hash].js`,
        assetFileNames: `assets/[name].[ext]`,
      },
    },
  },
  html: {
    cspNonce: 'ATOMICSERVER_NONCE',
  },
  server: {
    strictPort: true,
    host: true,
  },
});
