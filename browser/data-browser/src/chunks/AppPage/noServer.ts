// @wc-ignore-file
import type { Store } from '@tomic/react';

/**
 * Why an app cannot write as itself or call other apps in a page that has no
 * server (the embedded renderer).
 *
 * An app's view runs in the page (a `srcdoc` frame, `appFrameDocument.ts`),
 * but its writes and key go through the node's `/app-write` and `/app-agent`,
 * and each of those requests is signed with the agent. A `noServer` store's
 * agent lives in the host app, which signs commits of that agent and nothing
 * else, so signing such a request fails with "only commits are signed". Say so
 * up front instead.
 */
export const NO_SERVER_APP_MESSAGE =
  'Writing as the app and calling other apps need a server, and this page has none (it is the embedded app).';

/** Throws before anything is signed, when the store has no server to ask. */
export function requireServer(store: Pick<Store, 'noServer'>): void {
  if (store.noServer) throw new Error(NO_SERVER_APP_MESSAGE);
}
