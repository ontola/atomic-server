// @wc-ignore-file
/**
 * The document of an app's frame when the page has no server to serve it: a
 * TypeScript port of the server's shell
 * (`render_drive_plugin_ui_html_with` and `frame_csp` in
 * `server/src/handlers/plugin_ui.rs`). Keep the two in step;
 * `appFrameDocument.test.ts` compares their CSP directives.
 *
 * The frame is a sandboxed `srcdoc` (no `allow-same-origin`), so it is
 * null-origin and cannot touch the page. A `srcdoc` inherits the embedding
 * page's CSP, which would block the app's script, so the document carries its
 * own in a meta tag that narrows it: `connect-src 'none'` and no remote
 * images or fonts, so a view cannot send drive data anywhere. There is no
 * server to serve the sources from, so they travel inside the document and are
 * imported through blob URLs the frame makes itself (`blob:` in `script-src`
 * for that; the inline scripts need the nonce).
 */

/** `view-client.js`, the data API a view gets (a copy of the server's file). */
export { default as VIEW_CLIENT_SOURCE } from './viewClient.js?raw';

/** The CSP directives of the frame, by name (as the meta tag has them). */
export function frameCspDirectives(nonce: string): Record<string, string> {
  return {
    'default-src': "'none'",
    'script-src': `'nonce-${nonce}' blob:`,
    'style-src': "'unsafe-inline'",
    'img-src': 'data: blob:',
    'font-src': 'data:',
    'connect-src': "'none'",
    'base-uri': "'none'",
    'object-src': "'none'",
    'form-action': "'none'",
  };
}

export function frameCsp(nonce: string): string {
  return Object.entries(frameCspDirectives(nonce))
    .map(([name, value]) => `${name} ${value}`)
    .join('; ');
}

/** A fresh nonce for one frame. */
export function newFrameNonce(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));

  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

/** JSON that is safe inside a `<script>` element: no `<` can close or open it. */
function scriptJson(value: unknown): string {
  return JSON.stringify(value).replace(/</g, '\\u003c');
}

export function appFrameDocument({
  source,
  client,
  nonce,
}: {
  source: string;
  client: string;
  nonce: string;
}): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta http-equiv="Content-Security-Policy" content="${frameCsp(nonce)}" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>Plugin</title>
<style>html,body{margin:0;padding:0;height:100%}#root{height:100%}</style>
<style id="__atomic_theme"></style>
<script type="application/json" id="__atomic_sources">${scriptJson({ source, client })}</script>
<script type="module" nonce="${nonce}">
const root = document.getElementById('root');
try {
  const sources = JSON.parse(document.getElementById('__atomic_sources').textContent);
  const load = text => import(URL.createObjectURL(new Blob([text], { type: 'text/javascript' })));
  const plugin = await load(sources.source);
  const { store } = await load(sources.client);
  if (typeof plugin.view !== 'function') {
    throw new Error('This plugin exports no view() function.');
  }
  await plugin.view({ root, store });
  // Says it got to the end, and how much it drew. Silence is not success: an
  // app whose view() resolves having rendered nothing is a blank panel.
  if (window.parent) {
    window.parent.postMessage({
      type: '__atomic_plugin_rendered',
      children: root.childElementCount,
    }, '*');
  }
} catch (e) {
  root.textContent = String(e && e.message ? e.message : e);
  window.__atomicReportError(e, 'load');
}
</script>
<script nonce="${nonce}">
// Every error route out of the frame ends here, and goes to the host: the
// frame is null-origin, so its console belongs to nobody. This classic script
// runs before the module above (a module is deferred), so the reporter exists
// by the time a load-time throw looks for it.
window.__atomicReportError = function (error, phase) {
  if (!window.parent) return;

  var message = error && error.message ? error.message : String(error);

  window.parent.postMessage({
    type: '__atomic_plugin_error',
    phase: phase || 'runtime',
    message: message,
    stack: error && error.stack ? String(error.stack) : undefined,
  }, '*');
};

window.addEventListener('error', function (e) {
  window.__atomicReportError(e.error || e.message, 'runtime');
});

window.addEventListener('unhandledrejection', function (e) {
  window.__atomicReportError(e.reason, 'runtime');
});

window.addEventListener('message', function (e) {
  if (e.source !== window.parent) return;
  if (e.data && e.data.type === '__atomic_style') {
    var s = document.getElementById('__atomic_theme');
    if (s) s.textContent = e.data.css;
  }
});
if (window.parent) window.parent.postMessage({ type: '__atomic_plugin_ready' }, '*');
</script>
</head>
<body><div id="root"></div></body>
</html>`;
}
