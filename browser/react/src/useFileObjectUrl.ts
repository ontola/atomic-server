import {
  hexToBytes,
  isBlobSubject,
  blobHashHex,
  type Resource,
} from '@tomic/lib';
import { useEffect, useState } from 'react';
import { useStore } from './hooks.js';

const BLOB = 'https://atomicdata.dev/properties/blob';

// Object URLs are cached per (database, blob) so remounting an avatar-style
// image is instant instead of re-reading the blob and re-decoding a fresh URL
// each visit. Bounded, evicting (and revoking) the least recently used.
const MAX_CACHED_URLS = 64;
const urlCache = new Map<string, { db: unknown; url: string }>();

function cachedUrl(db: unknown, blobDid: string): string | undefined {
  const hit = urlCache.get(blobDid);

  if (!hit || hit.db !== db) return undefined;

  urlCache.delete(blobDid);
  urlCache.set(blobDid, hit);

  return hit.url;
}

function cacheUrl(db: unknown, blobDid: string, url: string): void {
  const previous = urlCache.get(blobDid);

  if (previous) URL.revokeObjectURL(previous.url);
  urlCache.delete(blobDid);
  urlCache.set(blobDid, { db, url });

  if (urlCache.size > MAX_CACHED_URLS) {
    const oldest = urlCache.keys().next().value as string;
    const evicted = urlCache.get(oldest);

    if (evicted) URL.revokeObjectURL(evicted.url);
    urlCache.delete(oldest);
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
  const blobValue = resource.get(BLOB);

  return useBlobObjectUrl(
    typeof blobValue === 'string' ? blobValue : undefined,
    fallbackUrl,
  );
}

/**
 * {@link useFileObjectUrl} for a bare blob reference (`atomic:blob:<hash>`),
 * for places that have no File resource at hand, such as an image in a
 * document, which keeps only its URL.
 */
export function useBlobObjectUrl(
  blobDid: string | undefined,
  fallbackUrl?: string,
): string | undefined {
  const store = useStore();
  const clientDb = store.getClientDb?.();
  const [resolved, setResolved] = useState<{
    blobDid: string;
    clientDb: typeof clientDb;
    url?: string;
  }>();

  useEffect(() => {
    if (!blobDid || !isBlobSubject(blobDid) || !clientDb) return;

    let cancelled = false;

    if (cachedUrl(clientDb, blobDid)) return;

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

        if (url) cacheUrl(clientDb, blobDid, url);

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

  const cached = cachedUrl(clientDb, blobDid);

  if (cached) return cached;

  // A result for the previous resource/database must never leak into this render.
  if (resolved?.blobDid !== blobDid || resolved.clientDb !== clientDb) {
    return undefined;
  }

  return resolved.url ?? fallbackUrl;
}
