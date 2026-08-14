/**
 * Deliberately NOT exported from `index.ts`, and worth keeping that way: its
 * only consumer is `client-db.worker.ts`, which apps load as a standalone file
 * (`import '@tomic/lib/client-db.worker.js?url'` copies that one file and
 * nothing else). A second importer would make tsup hoist this into a shared
 * chunk, and the worker's `import './chunk-XXXX.js'` would then 404 at runtime
 * and take the whole ClientDb down with it. Callers outside the worker build
 * their own url; see `data-browser/src/helpers/wasmUrls.ts`.
 *
 * The atomic-wasm glue and its binary are served from a stable `/wasm/` path
 * (they are copied into the app's `public/` dir by `build:wasm` rather than
 * going through Rollup), so their URL does not change when their content does.
 * Callers therefore append a build hash — `?v=<hash>` — to keep the pair in
 * step with the app chunks that call into them.
 */

/**
 * The binary URL belonging to a glue-JS URL, carrying the same query.
 *
 * wasm-bindgen's own default is `new URL('atomic_wasm_bg.wasm',
 * import.meta.url)`, and resolving a relative path that way drops the glue
 * URL's query string. A versioned glue would then be paired with whatever
 * binary sits under the bare path, which is a worse failure than the stale
 * glue this versioning exists to prevent: mismatched glue and binary fail
 * inside `WebAssembly.instantiate` on a missing import rather than at a
 * legible call site. Deriving it here keeps both halves on one version.
 */
export function wasmBinaryUrl(
  jsUrl: string,
  binaryName = 'atomic_wasm_bg.wasm',
): string {
  const base = typeof location === 'undefined' ? undefined : location.href;
  const url = new URL(jsUrl, base);
  url.pathname = url.pathname.replace(/[^/]*$/, binaryName);

  return url.toString();
}
