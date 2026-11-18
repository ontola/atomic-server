import {
  hexToBytes,
  isBlobSubject,
  blobHashHex,
  isLoopbackHost,
  server,
  type Resource,
} from '@tomic/lib';
import { useEffect, useState } from 'react';
import { useStore } from './hooks.js';

const BLOB = 'https://atomicdata.dev/properties/blob';
const DRIVE = 'https://atomicdata.dev/properties/drive';

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

/** A recovered native file must not reuse a cached failed download. */
function refreshedNativeUrl(url: string | undefined, revision: number) {
  if (!url || revision === 0) return url;

  try {
    const parsed = new URL(url);
    if (
      !['http:', 'https:'].includes(parsed.protocol) ||
      !isLoopbackHost(parsed.hostname) ||
      !parsed.pathname.startsWith('/download/') ||
      parsed.username ||
      parsed.password ||
      [...parsed.searchParams.keys()].some(key =>
        /^(sig(nature)?|token|authorization|credential|expires|x-amz-.+|x-goog-.+)$/i.test(
          key,
        ),
      )
    )
      return url;

    // Append to the original spelling so rendition parameters and fragments
    // keep their exact encoding. Arbitrary remote/signed URLs stay untouched.
    const fragment = url.indexOf('#');
    const head = fragment < 0 ? url : url.slice(0, fragment);
    const tail = fragment < 0 ? '' : url.slice(fragment);
    const separator = head.includes('?')
      ? /[?&]$/.test(head)
        ? ''
        : '&'
      : '?';

    return `${head}${separator}_atomic_file_recovery=${revision}${tail}`;
  } catch {
    return url;
  }
}

/**
 * Returns a `blob:` object URL for the file's bytes when they are available
 * locally in the WASM clientDb (e.g. just-uploaded files, or anything cached
 * from a prior session). On a miss, waits for the store's registered recovery
 * service and reads the local bytes again before returning the optional
 * network fallback. Returns `undefined` while lookup or recovery is pending.
 *
 * Lets the UI preview a freshly-uploaded image even before the bytes have
 * been pushed to the server, and lets it keep working while offline.
 */
export function useFileObjectUrl(
  resource: Resource,
  fallbackUrl?: string,
): string | undefined {
  const blobValue = resource.get(BLOB);
  const mimetypeValue = resource.get(server.properties.mimetype);
  const driveValue = resource.get(DRIVE);

  return useBlobObjectUrl(
    typeof blobValue === 'string' ? blobValue : undefined,
    fallbackUrl,
    typeof mimetypeValue === 'string' ? mimetypeValue : undefined,
    typeof driveValue === 'string' ? driveValue : undefined,
  );
}

/**
 * {@link useFileObjectUrl} for a bare blob reference (`atomic:blob:<hash>`),
 * for places that have no File resource at hand, such as an image in a
 * document, which keeps only its URL. Pass the file's `mimetype` when it is
 * known: an SVG only renders from an object URL typed `image/svg+xml`.
 * `driveSubject` scopes recovery when known; otherwise the service chooses
 * the current drive. Native stores without a ClientDb wait for recovery too,
 * then use the existing download URL.
 */
export function useBlobObjectUrl(
  blobDid: string | undefined,
  fallbackUrl?: string,
  mimetype?: string,
  driveSubject?: string,
): string | undefined {
  const store = useStore();
  const clientDb = store.getClientDb?.();
  const hasRecovery = store.hasFileContentRecovery?.() ?? false;
  const selectedDrive = store.getDrive?.();
  const agentSubject = store.getAgent?.()?.subject;
  const [recoveryRevision, setRecoveryRevision] = useState(0);
  // The same bytes with a different type are a different object URL.
  const cacheKey = blobDid ? `${blobDid}|${mimetype ?? ''}` : undefined;
  const [resolved, setResolved] = useState<{
    cacheKey: string;
    clientDb: typeof clientDb;
    store: typeof store;
    selectedDrive: typeof selectedDrive;
    agentSubject: typeof agentSubject;
    driveSubject: typeof driveSubject;
    recoveryRevision: number;
    nativePresent: boolean;
    url?: string;
  }>();

  useEffect(
    () =>
      store.onFileContentRecoveryChanged?.(hash => {
        if (
          !hash ||
          hash.toLowerCase() ===
            (blobDid && blobHashHex(blobDid)?.toLowerCase())
        )
          setRecoveryRevision(revision => revision + 1);
      }),
    [store, blobDid],
  );

  useEffect(() => {
    if (!blobDid || !isBlobSubject(blobDid) || (!clientDb && !hasRecovery))
      return;

    if (cachedUrl(clientDb, cacheKey!)) return;

    let cancelled = false;
    const current = () =>
      !cancelled &&
      store.getClientDb?.() === clientDb &&
      store.getDrive?.() === selectedDrive &&
      store.getAgent?.()?.subject === agentSubject;

    const settled = (url?: string, nativePresent = false) => {
      if (!current()) return;

      setResolved({
        cacheKey: cacheKey!,
        clientDb,
        store,
        selectedDrive,
        agentSubject,
        driveSubject,
        recoveryRevision,
        nativePresent,
        url,
      });
    };

    (async () => {
      try {
        const hashHex = blobHashHex(blobDid);
        if (!hashHex) return;
        const hash = hexToBytes(hashHex);
        let bytes = await clientDb?.getBlob(hash);
        let nativePresent = false;
        if (!current()) return;

        if (!bytes && hasRecovery) {
          const recovered = await store.recoverMissingFileContents(
            hashHex,
            driveSubject,
          );
          if (!current()) return;

          nativePresent = !clientDb && recovered;

          bytes = await clientDb?.getBlob(hash);
          if (!current()) return;
        }

        // The Blob's type becomes the object URL's Content-Type. Without it
        // an `<img>` can still sniff raster formats, but never SVG: browsers
        // only render SVG when the type is exactly `image/svg+xml`.
        const url = bytes
          ? URL.createObjectURL(
              new Blob([bytes as BlobPart], mimetype ? { type: mimetype } : {}),
            )
          : undefined;

        if (url && clientDb) rememberUrl(clientDb, cacheKey!, url);

        settled(url, nativePresent);
      } catch {
        settled();
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [
    blobDid,
    cacheKey,
    clientDb,
    mimetype,
    store,
    hasRecovery,
    selectedDrive,
    agentSubject,
    driveSubject,
    recoveryRevision,
  ]);

  if (!blobDid || !isBlobSubject(blobDid) || (!clientDb && !hasRecovery))
    return fallbackUrl;

  const known = cachedUrl(clientDb, cacheKey!);

  if (known) return known;

  // A result for the previous resource/database must never leak into this render.
  if (
    !resolved ||
    resolved.cacheKey !== cacheKey ||
    resolved.clientDb !== clientDb ||
    resolved.store !== store ||
    resolved.selectedDrive !== selectedDrive ||
    resolved.agentSubject !== agentSubject ||
    resolved.driveSubject !== driveSubject ||
    resolved.recoveryRevision !== recoveryRevision
  ) {
    return undefined;
  }

  return (
    resolved.url ??
    (resolved.nativePresent
      ? refreshedNativeUrl(fallbackUrl, recoveryRevision)
      : fallbackUrl)
  );
}
