import { env } from '@/env';
import { Store } from '@tomic/lib';
import { CMS_REVALIDATE_SECONDS } from '@/atomic/feeds';

export const store = new Store({
  serverUrl: env.NEXT_PUBLIC_ATOMIC_SERVER_URL,
});

store.setDrive(env.NEXT_PUBLIC_ATOMIC_DRIVE);

// Server Components have no browser connection lifecycle. Mark the HTTP
// origin available so collection queries use the server instead of the empty
// local fallback; client-side stores still derive this state from WebSocket.
if (typeof window === 'undefined') {
  store.setServerConnected(true);
  // ISR / CDN: cache AtomicServer reads for `CMS_REVALIDATE_SECONDS`. A
  // transient empty collection at build is retried in getAllBlogposts /
  // getPublicPages, then expires instead of sticking until the next deploy.
  store.injectFetch((input, init) =>
    fetch(input, {
      ...init,
      next: { revalidate: CMS_REVALIDATE_SECONDS },
    }),
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
