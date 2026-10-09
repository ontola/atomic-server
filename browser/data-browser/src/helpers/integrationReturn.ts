// @wc-ignore-file
// The way back from connecting an integration through the system browser
// (ontola/atomic-server#2163, ontola/atomic-plugins#54 section 4c).
//
// Providers such as Google refuse OAuth inside embedded webviews, so in the
// Tauri apps the proxy's /connect opens in the system browser and the proxy
// sends that browser to `atomic://integrations/return?…`, which the OS hands
// to the app. Nothing in the link is a credential: redeeming its handoff code
// needs the PKCE verifier saved in this webview and a signature by the user
// key, so another app registered for `atomic://` gets nothing from it.

/** Where the proxy returns in the Tauri apps. */
export const TAURI_INTEGRATION_RETURN = 'atomic://integrations/return';

/** Where the proxy returns on the web: the integrations page of this origin. */
export function webIntegrationReturn(pageOrigin: string): string {
  return new URL('/app/integrations', pageOrigin).href;
}

/** The return address to give the proxy. */
export function integrationReturnAddress(
  inTauri: boolean,
  pageOrigin: string,
): string {
  return inTauri ? TAURI_INTEGRATION_RETURN : webIntegrationReturn(pageOrigin);
}

/**
 * The query of an `atomic://integrations/return` link, or `undefined` when
 * `uri` is anything else or carries no `integration_state` (the page then
 * ignores it: a return always names the handoff it belongs to).
 */
export function parseIntegrationReturn(
  uri: string,
): URLSearchParams | undefined {
  let url: URL;

  try {
    url = new URL(uri);
  } catch {
    return undefined;
  }

  if (
    url.protocol !== 'atomic:' ||
    url.hostname !== 'integrations' ||
    url.pathname.replace(/\/+$/, '') !== '/return'
  )
    return undefined;

  return url.searchParams.get('integration_state')
    ? url.searchParams
    : undefined;
}

type Listener = (params: URLSearchParams) => void;

let listener: Listener | undefined;
const early: URLSearchParams[] = [];

/**
 * Hand a parsed return to whoever redeems it. One that arrives before
 * `ProxyConnectReturn` has mounted (the link launched the app) is kept.
 */
export function deliverIntegrationReturn(params: URLSearchParams): void {
  if (listener) listener(params);
  else early.push(params);
}

/** Receive returns, including those that arrived early. */
export function setIntegrationReturnListener(fn: Listener): () => void {
  listener = fn;
  early.splice(0).forEach(p => fn(p));

  return () => {
    if (listener === fn) listener = undefined;
  };
}
