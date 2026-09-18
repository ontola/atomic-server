/**
 * Drop fetches the Tauri app never uses from the HTML shell.
 *
 * Document-level WASM preloads are already gone from `index.html` (the
 * ClientDb worker does not consume them). This still strips any leftover
 * `/wasm/` links, plus the atomicdata.dev preconnect — the embed talks to
 * localhost. Called from `vite.config.ts` when `TAURI=1`.
 */
export function stripUnusedTauriPreloads(html: string): string {
  return html
    .replace(/[ \t]*<link\b[^>]*href="[^"]*\/wasm\/[^"]*"[^>]*\/?>\s*/gi, '')
    .replace(
      /[ \t]*<link\b[^>]*href="https:\/\/atomicdata\.dev"[^>]*\/?>\s*/gi,
      '',
    );
}
