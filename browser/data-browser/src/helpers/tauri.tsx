// This application can be used in a Tauri context.

declare global {
  interface Window {
    __TAURI_INTERNALS__?: unknown;
    __TAURI_METADATA__?: unknown;
  }
}

export function isRunningInTauri(): boolean {
  if (typeof window === 'undefined') return false;

  // Tauri 2 exposes __TAURI_INTERNALS__; Tauri 1 exposed __TAURI_METADATA__.
  // The tauri: protocol fallback covers cases where the global isn't set yet
  // (e.g. top-level module evaluation before the runtime injects it).
  return (
    window.__TAURI_INTERNALS__ !== undefined ||
    window.__TAURI_METADATA__ !== undefined ||
    window.location.protocol === 'tauri:'
  );
}

/**
 * The origin of the atomic-server this app talks to.
 * - In Tauri: the embedded server on http://localhost:9883 (window.location.origin
 *   is `tauri://localhost` which isn't a fetchable HTTP URL)
 * - In a regular browser: window.location.origin
 *
 * Use this anywhere you were reaching for `window.location.origin` as "my server".
 */
export function getLocalServerOrigin(): string {
  if (isRunningInTauri()) {
    return 'http://localhost:9883';
  }

  return window.location.origin;
}
