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

let compiled: Promise<WebAssembly.Module> | undefined;

/**
 * The binary behind {@link wasmBinaryUrl}, fetched and compiled once per page.
 *
 * Three places instantiate it: the ClientDb worker, and on the main thread the
 * key wrapping a new identity's database needs and the recovery KDF. Each used
 * to download the 7 MB file for itself, so a first visit to the demo fetched it
 * twice over a connection that was busy with everything else. index.html starts
 * this compile before the app's JavaScript has even loaded; everyone shares it,
 * and a compiled module can be handed to a worker as is.
 *
 * Resolves `undefined` when it cannot be compiled this way (an old browser, or
 * a server sending the wrong MIME type); callers then pass the url instead.
 */
export function compiledAtomicWasm(): Promise<WebAssembly.Module | undefined> {
  if (!compiled) {
    const early = (
      window as { __atomicWasmModule?: Promise<WebAssembly.Module> }
    ).__atomicWasmModule;

    compiled =
      early ??
      (typeof WebAssembly.compileStreaming === 'function'
        ? WebAssembly.compileStreaming(fetch(wasmBinaryUrl()))
        : Promise.reject(new Error('compileStreaming is unavailable')));
  }

  return compiled.catch(() => undefined);
}

/** What to hand the glue's `default({ module_or_path })`. */
export async function atomicWasmSource(): Promise<WebAssembly.Module | string> {
  return (await compiledAtomicWasm()) ?? wasmBinaryUrl();
}
