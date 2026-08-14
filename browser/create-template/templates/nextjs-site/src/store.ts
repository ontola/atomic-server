import { env } from '@/env';
import { Store } from '@tomic/lib';

export const store = new Store({
  serverUrl: env.NEXT_PUBLIC_ATOMIC_SERVER_URL,
});

store.setDrive(env.NEXT_PUBLIC_ATOMIC_DRIVE);

// Server Components have no browser connection lifecycle. Mark the HTTP
// origin available so collection queries use the server instead of the empty
// local fallback; client-side stores still derive this state from WebSocket.
if (typeof window === 'undefined') {
  store.setServerConnected(true);
  // Next.js caches `fetch` during SSR and `next build`. An empty collection
  // on first hit (index still catching up after applying the template) would
  // then be reused, so blog listings stay empty until a rebuild.
  store.injectFetch((input, init) =>
    fetch(input, { ...init, cache: 'no-store' }),
  );
}

/**
 * Extra AND-constraint that pins a collection query to this site's drive.
 * The server's basic property/value index is shared across all drives it
 * hosts, so shared values (hrefs like `/blog`, template localIds) would
 * otherwise match resources from other drives on the same server.
 */
export const driveFilter = {
  property: 'https://atomicdata.dev/properties/drive',
  value: env.NEXT_PUBLIC_ATOMIC_DRIVE,
};
