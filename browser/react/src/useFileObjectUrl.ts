import {
  hexToBytes,
  isBlobSubject,
  blobHashHex,
  type Resource,
} from '@tomic/lib';
import { useEffect, useState } from 'react';
import { useStore } from './hooks.js';

const BLOB = 'https://atomicdata.dev/properties/blob';

/**
 * Object URLs already made for a blob, per database, most recently used last.
 *
 * Without this every mount read the bytes out of the database again, returned
 * `undefined` until it finished, and made a brand new `blob:` URL the browser
 * had to decode from scratch, so an avatar on a page you reopen popped in late
 * every time. Kept small because this hook also serves large file previews;
 * the oldest URL is revoked when the list is full.
 */
const MAX_CACHED_URLS = 24;
const urlCache = new WeakMap<object, Map<string, string>>();

function cachedUrl(db: object | undefined, blobDid: string) {
  const entries = db ? urlCache.get(db) : undefined;
  const url = entries?.get(blobDid);

  if (url && entries) {
    // Refresh recency.
    entries.delete(blobDid);
    entries.set(blobDid, url);
  }

  return url;
}

function rememberUrl(db: object, blobDid: string, url: string) {
  let entries = urlCache.get(db);

  if (!entries) {
    entries = new Map();
    urlCache.set(db, entries);
  }

  entries.set(blobDid, url);

  if (entries.size > MAX_CACHED_URLS) {
    const [oldest] = entries.keys();
    const evicted = entries.get(oldest);
    entries.delete(oldest);

    if (evicted) URL.revokeObjectURL(evicted);
  }
}

/**
 * Returns a `blob:` object URL for the file's bytes when they are available
 * locally in the WASM clientDb (e.g. just-uploaded files, or anything cached
 * from a prior session). Waits for the local lookup before returning the
 * optional network fallback. Returns `undefined` while the lookup is pending.
 *
 * Lets the UI preview a freshly-uploaded image even before the bytes have
 * been pushed to the server, and lets it keep working while offline.
 */
export function useFileObjectUrl(
  resource: Resource,
  fallbackUrl?: string,
): string | undefined {
  const store = useStore();
  const clientDb = store.getClientDb?.();
  const [resolved, setResolved] = useState<{
    blobDid: string;
    clientDb: typeof clientDb;
    url?: string;
  }>();

  const blobValue = resource.get(BLOB);
  const blobDid = typeof blobValue === 'string' ? blobValue : undefined;

  useEffect(() => {
    if (!blobDid || !isBlobSubject(blobDid) || !clientDb) return;

    if (cachedUrl(clientDb, blobDid)) return;

    let cancelled = false;

    (async () => {
      try {
        const hashHex = blobHashHex(blobDid);
        if (!hashHex) return;
        const hash = hexToBytes(hashHex);
        const bytes = await clientDb.getBlob(hash);
        if (cancelled) return;

        const url = bytes
          ? URL.createObjectURL(new Blob([bytes as BlobPart]))
          : undefined;

        if (url) rememberUrl(clientDb, blobDid, url);

        setResolved({ blobDid, clientDb, url });
      } catch {
        if (!cancelled) setResolved({ blobDid, clientDb });
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [blobDid, clientDb]);

  if (!blobDid || !isBlobSubject(blobDid) || !clientDb) return fallbackUrl;

  const known = cachedUrl(clientDb, blobDid);

  if (known) return known;

  // A result for the previous resource/database must never leak into this render.
  if (resolved?.blobDid !== blobDid || resolved.clientDb !== clientDb) {
    return undefined;
  }

  return resolved.url ?? fallbackUrl;
}
