import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import babel from '@rolldown/plugin-babel';
import { VitePWA } from 'vite-plugin-pwa';
import webfontDownload from 'vite-plugin-webfont-dl';
import prismjs from 'vite-plugin-prismjs';
import wasm from 'vite-plugin-wasm';
import { wuchale } from '@wuchale/vite-plugin';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { execSync } from 'node:child_process';

// TAURI=1 produces a Tauri-compatible bundle: no CSP nonces (Tauri serves
// HTML verbatim, so the server's runtime ATOMICSERVER_NONCE substitution
// doesn't happen), no PWA service worker (tauri:// isn't HTTP), separate
// outDir so the server build keeps its own nonce'd dist.
const isTauri = process.env.TAURI === '1';
const isVitest = process.env.VITEST === 'true';

const repoLibDefaults = path.resolve(__dirname, '../../lib/defaults');
const ciLibDefaults = path.resolve(__dirname, '../lib-defaults');
const libDefaultsDir = fs.existsSync(
  path.join(repoLibDefaults, 'default_base_models.json'),
)
  ? repoLibDefaults
  : ciLibDefaults;

// Build/version info surfaced on the About page. Computed at build time and
// injected via `define`. Falls back gracefully outside a git checkout.
const appVersion = (
  JSON.parse(
    fs.readFileSync(path.resolve(__dirname, 'package.json'), 'utf-8'),
  ) as { version: string }
).version;

let gitCommit = 'unknown';

try {
  gitCommit = execSync('git rev-parse --short HEAD', { cwd: __dirname })
    .toString()
    .trim();
} catch {
  // Not a git checkout (e.g. published tarball) — leave as 'unknown'.
}

const buildTime = new Date().toISOString();

export default defineConfig({
  define: {
    __APP_VERSION__: JSON.stringify(appVersion),
    __GIT_COMMIT__: JSON.stringify(gitCommit),
    __BUILD_TIME__: JSON.stringify(buildTime),
  },
  resolve: {
    // `loro-prosemirror` is excluded from dep-optimization (see
    // optimizeDeps.exclude — it pulls in the WASM `loro-crdt`), so its
    // `import "prosemirror-view"` is served raw from node_modules. Meanwhile
    // tiptap's ProseMirror is prebundled into an optimized chunk. Without
    // deduping, that yields TWO copies of the `prosemirror-view` module at
    // runtime: a `DecorationSet` produced by loro's cursor plugin then fails
    // `instanceof DecorationSet` inside tiptap's `DecorationGroup.from`, which
    // reads `.members` off the foreign set (undefined) and pushes it as a null
    // group member — crashing `DecorationGroup.locals` ("Cannot read
    // properties of undefined (reading 'localsInner')") on the next view
    // update (e.g. opening the slash menu next to a collaborator cursor).
    // Deduping forces a single shared instance so the `instanceof` holds.
    dedupe: ['prosemirror-view', 'prosemirror-state', 'prosemirror-model'],
    alias: [
      // Force EVERY `loro-crdt` import (our `enableLoro`, plus
      // `loro-prosemirror` used by the editor) onto the `web` build.
      // The default entry resolves via the `module` field to the
      // `bundler` build, whose WASM↔JS circular import + top-level
      // -await glue hangs under `vite-plugin-wasm` (loro-crdt ≥ 1.12).
      // Aliasing to one build also guarantees a SINGLE Loro module
      // instance — otherwise a web-build `LoroDoc` handed to a
      // bundler-build `loro-prosemirror` fails `instanceof` checks and
      // the two WASM memories diverge. Exact-match regex so the
      // `loro-crdt/web` subpath import in `LoroLoader` is left alone.
      { find: /^loro-crdt$/, replacement: 'loro-crdt/web' },
      { find: '@components', replacement: path.resolve(__dirname, 'src/components') },
      { find: '@views', replacement: path.resolve(__dirname, 'src/views') },
      { find: '@hooks', replacement: path.resolve(__dirname, 'src/hooks') },
      { find: '@helpers', replacement: path.resolve(__dirname, 'src/helpers') },
      { find: '@chunks', replacement: path.resolve(__dirname, 'src/chunks') },
      { find: '@repo-lib-defaults', replacement: libDefaultsDir },
    ],
  },
  plugins: [
    wasm(),
    !isVitest && webfontDownload(),
    !isVitest && wuchale(),
    // OXC handles the bulk JSX/TS transform via @vitejs/plugin-react v6.
    // The two passes we still need babel for ride on @rolldown/plugin-babel,
    // which MUST run before `react()` ("the compiler must run before other
    // transforms" — React Compiler docs):
    //
    //  - babel-plugin-react-compiler: auto-memoising compiler. No SWC/OXC
    //    port exists yet (Oct 2026); React's official Vite recipe is this
    //    same two-pass setup.
    //  - babel-plugin-styled-components: emits `displayName` so DOM classes
    //    read `Foo-sc-XXX` instead of opaque `sc-XXX` hashes. plugin-react
    //    v6 dropped its own `babel` option, so this is now the only hook.
    babel({
      include: /\.[jt]sx?$/,
      exclude: /node_modules/,
      plugins: [
        [
          'babel-plugin-react-compiler',
          {
            logger: {
              logEvent(filename, event) {
                if (event.kind === 'CompileError') {
                  console.error(`\nCompilation failed: ${filename}`);
                  console.error(`Reason: ${event.detail.reason}`);

                  if (event.detail.description) {
                    console.error(`Details: ${event.detail.description}`);
                  }

                  if (event.detail.loc) {
                    const { line, column } = event.detail.loc.start;
                    console.error(`Location: Line ${line}, Column ${column}`);
                  }

                  if (event.detail.suggestions) {
                    console.error('Suggestions:', event.detail.suggestions);
                  }
                }
              },
            },
          },
        ],
        [
          'babel-plugin-styled-components',
          { displayName: true, fileName: false },
        ],
      ],
    }),
    react(),
    !isVitest &&
      !isTauri &&
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
          // Purge precache entries from prior builds on SW activation, so a
          // stale worker/wasm can never linger after the hashed names change.
          cleanupOutdatedCaches: true,
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
    !isVitest &&
      prismjs({
        languages: ['typescript', 'json', 'diff'],
        plugins: ['diff-highlight'],
        css: true,
        theme: 'default',
      }),
  ],
  optimizeDeps: {
    // React Compiler emits `import { c as _c } from "react/compiler-runtime"`
    // in every memoised component. Without this hint, Vite only discovers
    // the dep the first time a compiled module loads — it prebundles
    // mid-session and serves a half-written file to the next request,
    // surfacing as `NS_ERROR_CORRUPTED_CONTENT` + empty MIME type on the
    // browser. Listing it up front makes the optimization happen at boot.
    //
    // The AI SDK graph (`ai`, `@ai-sdk/react`, the provider packages and the
    // MCP SDK) is only reachable behind the `React.lazy` AI sidebar chunk, so
    // Vite's boot-time scan (which follows static imports from index.html)
    // never sees it. The first time the sidebar opens, Vite discovers the
    // whole graph, re-optimizes, and HARD-RELOADS the page — surfacing as a
    // ~20s "Loading AI" stall (the lazy chunk's Suspense fallback). Listing
    // them here prebundles them at boot so first-open is warm. Dev-only:
    // production builds prebundle everything at build time. Keep in sync with
    // the AI-only deps in `src/chunks/AI/`.
    include: [
      'react/compiler-runtime',
      'ai',
      '@ai-sdk/react',
      'zod',
      'ollama-ai-provider-v2',
      '@openrouter/ai-sdk-provider',
      '@modelcontextprotocol/sdk/client/index.js',
      '@modelcontextprotocol/sdk/client/sse.js',
      '@modelcontextprotocol/sdk/client/streamableHttp.js',
      'fast-json-patch',
      // Prebundle the collaborative editor's CRDT-ProseMirror bridge into the
      // same optimize graph as tiptap so they share ONE `prosemirror-view`
      // instance (see the exclude note below re: the DecorationGroup crash).
      // `loro-crdt` stays external, so the WASM is unaffected.
      'loro-prosemirror',
    ],
    // `loro-crdt` ships a WASM module that `vite-plugin-wasm` (see the
    // `wasm()` plugin above) handles. esbuild's dep-optimizer CANNOT —
    // if Vite prebundles loro-crdt, the WASM init in the optimized
    // chunk hangs forever: `import('loro-crdt')` in `enableLoro()`
    // never resolves OR rejects, so `LoroLoader.isLoaded()` stays
    // false, every `getLoroDoc()` returns undefined, and documents are
    // stuck (now surfaced as the "editor failed to load" error in
    // `DocumentV2FullPage`). Excluding it from optimization lets
    // `vite-plugin-wasm` serve the module untouched. This is the
    // documented requirement for WASM deps under vite-plugin-wasm.
    //
    // It also explains the *intermittent* original failure: with
    // loro-crdt neither included nor excluded, Vite auto-discovered it
    // on the first lazy import and tried to optimize it mid-session —
    // sometimes racing cleanly, sometimes hanging. Excluding makes it
    // deterministic.
    // Both must skip esbuild prebundling: the `web` build loads its
    // `.wasm` via `fetch(new URL('loro_wasm_bg.wasm', import.meta.url))`.
    // If esbuild inlines either into an optimized chunk, `import.meta.url`
    // points at `.vite/deps/…` where the `.wasm` doesn't exist → 404.
    // Excluding keeps it served from `node_modules` so the relative
    // `.wasm` URL resolves.
    //
    // NOTE: `loro-prosemirror` is deliberately NOT excluded (it's `include`d
    // above). It only imports `loro-crdt` as a peer, which stays external
    // here, so optimizing it doesn't drag the WASM into a chunk. Crucially,
    // optimizing it puts its `prosemirror-view`/`-state`/`-model` imports in
    // the SAME prebundled graph as tiptap's. If loro were excluded (served
    // raw) while tiptap's ProseMirror was prebundled, there would be TWO
    // runtime copies of `prosemirror-view`: a `DecorationSet` from loro's
    // cursor plugin then fails `instanceof DecorationSet` inside tiptap's
    // `DecorationGroup.from`, which reads `.members` off the foreign set
    // (undefined) and stores it as a null group member — crashing
    // `DecorationGroup.locals` ("Cannot read properties of undefined (reading
    // 'localsInner')") on the next view update (e.g. opening the slash menu
    // next to a collaborator's caret). One optimize graph + `resolve.dedupe`
    // above keeps it a single instance. (Prod is unaffected: rollup bundles
    // once.)
    exclude: ['loro-crdt'],
    // this may help when linking + HMR is not working
    // exclude: ['@tomic/lib', '@tomic/react'],
    //
    // Vite's boot-time dep scan only follows static imports from index.html, so
    // it never sees the deps behind `React.lazy` chunks (RTE/tiptap, AI SDK,
    // code/table/PDF editors). The first time such a chunk loads, Vite
    // discovers its deps mid-session, re-optimizes, and 504s the in-flight
    // dynamic import ("Outdated Optimize Dep" → "Failed to fetch dynamically
    // imported module: CollaborativeEditor.tsx"). Crawling the chunk roots at
    // boot pre-optimizes everything, so first-open is warm and e2e is stable.
    entries: ['./index.html', './src/chunks/**/*.{ts,tsx}'],
  },
  build: {
    target: 'baseline-widely-available',
    outDir: isTauri ? 'dist-tauri' : 'dist',
    sourcemap: true,
    // Don't inline worker scripts as `data:` URLs — the production CSP is
    // `worker-src 'self'` and would block them, killing the ClientDb. Below
    // the default 4096-byte limit, Vite would otherwise inline our 1.7KB
    // ClientDb worker and break in prod (works in dev because dev has no CSP).
    assetsInlineLimit: (filePath: string) =>
      filePath.endsWith('.worker.js') ? 0 : undefined,
    rollupOptions: {
      output: {
        entryFileNames: `assets/[name]-[hash].js`,
        chunkFileNames: `assets/chunk_[name]-[hash].js`,
        // Content-hash ALL assets — including the `?url`-imported ClientDb
        // worker and the loro-crdt `.wasm`. With stable names these were
        // precached by Workbox with `revision: null` (it assumes an unhashed
        // name is immutable), so a content change kept the same URL+revision
        // and the SW served the OLD worker/wasm to NEW hashed chunks forever:
        // a soft (cmd+r) reload hit a stale worker (missing newer message
        // handlers → empty resources) and the stale loro bundler glue
        // (`./loro_wasm_bg.js` import error). Hashing makes every change a new
        // URL Workbox correctly re-fetches. atomic-wasm is unaffected: it's
        // served from the stable `/wasm/` public path, not via this pipeline.
        assetFileNames: `assets/[name]-[hash].[ext]`,
      },
    },
  },
  html: {
    cspNonce: isTauri ? undefined : 'ATOMICSERVER_NONCE',
  },
  server: {
    strictPort: true,
    host: true,
    allowedHosts: ['.tunn.dev', 't-1sk9qbdw.tunn.dev'],
    // Pre-transform the lazy AI chunk's source graph in the background at
    // boot, so the first time the sidebar opens its modules are already
    // through the (slow) React Compiler babel pass instead of being
    // transformed on-demand while the user waits behind "Loading AI".
    // Complements the `optimizeDeps.include` AI entries above (those cover
    // the npm deps; this covers our own source modules).
    warmup: {
      clientFiles: [
        './src/chunks/AI/AISidebar.tsx',
        './src/chunks/AI/AIChatInput.tsx',
      ],
    },
    proxy: {
      '/iroh-node-id': 'http://localhost:9883',
      '/iroh-sync': 'http://localhost:9883',
    },
  },
});
