// Deep links (atomic://…) reach the webview as 'atomic-deep-link' DOM events,
// dispatched by the Tauri shell (desktop/src/lib.rs). This module's listener
// is registered at module scope from the app entry — before React mounts — so
// a link that launched the app (system camera scanning a pairing QR) is
// queued rather than lost. `PairingLinkHandler` installs the sink and drains
// the queue once the UI is ready.

const queue: string[] = [];
let sink: ((uri: string) => void) | undefined;

if (typeof window !== 'undefined') {
  window.addEventListener('atomic-deep-link', event => {
    const uri = (event as CustomEvent).detail;

    if (typeof uri !== 'string') {
      return;
    }

    if (sink) {
      sink(uri);
    } else {
      queue.push(uri);
    }
  });
}

/** Install the live handler and immediately drain anything that arrived early. */
export function setDeepLinkSink(handler: (uri: string) => void): void {
  sink = handler;
  queue.splice(0).forEach(handler);
}

export function clearDeepLinkSink(handler: (uri: string) => void): void {
  if (sink === handler) {
    sink = undefined;
  }
}
