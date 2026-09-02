/**
 * Where the app loads atomic-wasm from.
 *
 * The glue and its binary are served from `/wasm/` on the app's own origin
 * (in Tauri that's the bundled `tauri://localhost`), a path that stays the
 * same across builds because those files are copied into `public/` rather
 * than run through Rollup. Everything else the app loads is content-hashed by
 * Vite, so this pair was the one place where a cache — the service worker's
 * precache in particular — could hand a page an older build's file under a url
 * the new build still asks for. `__WASM_VERSION__` (the pair's content hash,
 * computed in vite.config.ts) closes that gap.
 */
export function wasmJsUrl(origin: string = window.location.origin): string {
  return `${origin}/wasm/atomic_wasm.js?v=${__WASM_VERSION__}`;
}

/**
 * The binary belonging to {@link wasmJsUrl}, on the same version.
 *
 * Pass this to the glue's `default({ module_or_path })` rather than letting
 * wasm-bindgen default to `new URL('atomic_wasm_bg.wasm', import.meta.url)`:
 * that relative resolve drops the `?v=` and can pair this build's glue with a
 * cached binary from another one, which fails deep inside instantiation
 * instead of at a call site. (The ClientDb worker does the same thing via its
 * own copy of this, in `@tomic/lib`'s `wasm-url.ts` — it cannot import from
 * here, or from anywhere, without breaking its single-file packaging.)
 */
export function wasmBinaryUrl(origin: string = window.location.origin): string {
  return `${origin}/wasm/atomic_wasm_bg.wasm?v=${__WASM_VERSION__}`;
}
