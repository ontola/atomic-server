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
  // The origin fallbacks cover the window before the runtime injects those
  // globals — a call made during that window would otherwise be told this is
  // an ordinary web page.
  //
  // Both shapes are needed. The desktop webview serves from `tauri://localhost`,
  // but Android serves from `http://tauri.localhost`, so a protocol-only check
  // silently fails there. That is not hypothetical: it made `getManagedApiBase()`
  // return the same-origin `/api`, and `tauri.localhost/api/me` answers 200 with
  // the SPA's own HTML rather than failing — so a linked device was told it had
  // no session, by its own index page.
  return (
    window.__TAURI_INTERNALS__ !== undefined ||
    window.__TAURI_METADATA__ !== undefined ||
    window.location.protocol === 'tauri:' ||
    window.location.hostname === 'tauri.localhost'
  );
}

/**
 * Whether this is the Tauri app on a phone/tablet, where a camera and the
 * native barcode scanner exist. The scanner plugin is compiled in for
 * Android/iOS only (see desktop/Cargo.toml), so invoking it on the desktop
 * app fails at runtime — gate the scan UI on this, not on `isRunningInTauri`.
 */
export function isMobileTauri(): boolean {
  return (
    isRunningInTauri() &&
    typeof navigator !== 'undefined' &&
    /android|iphone|ipad/i.test(navigator.userAgent)
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
