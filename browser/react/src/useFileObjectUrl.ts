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

    let revoked: string | undefined;
    let cancelled = false;

    (async () => {
      try {
        const hashHex = blobHashHex(blobDid);
        if (!hashHex) return;
        const hash = hexToBytes(hashHex);
        const bytes = await clientDb.getBlob(hash);
        if (cancelled) return;

        if (bytes) {
          revoked = URL.createObjectURL(new Blob([bytes as BlobPart]));
        }

        setResolved({ blobDid, clientDb, url: revoked });
      } catch {
        if (!cancelled) setResolved({ blobDid, clientDb });
      }
    })();

    return () => {
      cancelled = true;
      if (revoked) URL.revokeObjectURL(revoked);
    };
  }, [blobDid, clientDb]);

  if (!blobDid || !isBlobSubject(blobDid) || !clientDb) return fallbackUrl;

  // A result for the previous resource/database must never leak into this render.
  if (resolved?.blobDid !== blobDid || resolved.clientDb !== clientDb) {
    return undefined;
  }

  return resolved.url ?? fallbackUrl;
}
