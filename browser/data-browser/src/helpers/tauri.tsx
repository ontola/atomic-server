import { useEffect, useState } from 'react';
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

/**
 * The macOS desktop app draws its window controls over the page (an overlay
 * title bar, see `desktop/tauri.conf.json`), so the top bar must leave room for
 * them and act as the drag handle. `/Mac/` as a regex, not a string, so the
 * translation extractor leaves it alone.
 */
export function hasOverlayTitleBar(): boolean {
  return isRunningInTauri() && /Mac/.test(navigator.platform);
}

/**
 * Whether the window controls are covering the top-left corner right now: they
 * are in a normal window and gone in full screen, where the bar should use the
 * whole width again.
 */
export function useWindowControlsInset(): boolean {
  const overlay = hasOverlayTitleBar();
  const [fullscreen, setFullscreen] = useState(false);

  useEffect(() => {
    if (!overlay) return;

    let active = true;
    let unlisten: (() => void) | undefined;

    void (async () => {
      const { getCurrentWindow } = await import('@tauri-apps/api/window');
      const win = getCurrentWindow();
      const check = async () => {
        const full = await win.isFullscreen();

        if (active) setFullscreen(full);
      };

      await check();
      // Entering or leaving full screen resizes the window.
      unlisten = await win.onResized(() => void check());
    })().catch(() => undefined);

    return () => {
      active = false;
      unlisten?.();
    };
  }, [overlay]);

  return overlay && !fullscreen;
}
