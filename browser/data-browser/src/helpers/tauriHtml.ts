/**
 * Drop fetches the Tauri app never uses from the HTML shell.
 *
 * The OPFS ClientDb is off under Tauri, so the ~6MB atomic-wasm preloads
 * on the critical path are wasted work that delays first paint. The
 * atomicdata.dev preconnect is the same: the embed talks to localhost.
 * Called from `vite.config.ts` when `TAURI=1`.
 */
export function stripUnusedTauriPreloads(html: string): string {
  return html
    .replace(/[ \t]*<link\b[^>]*href="[^"]*\/wasm\/[^"]*"[^>]*\/?>\s*/gi, '')
    .replace(
      /[ \t]*<link\b[^>]*href="https:\/\/atomicdata\.dev"[^>]*\/?>\s*/gi,
      '',
    );
}
