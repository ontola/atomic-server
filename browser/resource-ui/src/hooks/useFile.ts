import {
  Resource,
  isSafeHref,
  server,
  useFileObjectUrl,
  useNumber,
  useStore,
  useString,
} from '@tomic/react';
import { useCallback, useEffect, useState } from 'react';

type FileInfo =
  | {
      loading: true;
      downloadUrl: undefined;
      downloadFile: () => void;
      mimeType: undefined;
      bytes: undefined;
    }
  | {
      loading: false;
      downloadUrl: string;
      downloadFile: () => void;
      mimeType: string;
      bytes: number;
    };

const DOWNLOAD_PATH = /^\/download\/files\/[^/]+$/;

/**
 * The File's own `downloadURL` names the node that first got the upload. A
 * client that talks to another server (the desktop app's embedded one, which
 * has no WASM client DB to serve the bytes locally) can hold the blob there
 * while that node answers 404. Ask once; only a clear 404 switches to this
 * client's own server. Any other answer, including a blocked request, keeps
 * the resource's URL, which is what loaded before.
 */
function useConnectedServerFallback(
  url: string | undefined,
): string | undefined {
  const serverUrl = useStore().getServerUrl();
  const [answer, setAnswer] = useState<{ url: string; use?: string }>();

  useEffect(() => {
    if (!url || !serverUrl) return;

    let target: URL;
    let local: URL;

    try {
      target = new URL(url);
      local = new URL(serverUrl);
    } catch {
      return;
    }

    if (
      target.origin === local.origin ||
      !DOWNLOAD_PATH.test(target.pathname)
    ) {
      return;
    }

    const alternative = new URL(target.pathname, local).toString();
    const controller = new AbortController();

    fetch(url, { method: 'HEAD', signal: controller.signal })
      .then(response => {
        setAnswer({
          url,
          use: response.status === 404 ? alternative : undefined,
        });
      })
      .catch(() => {});

    return () => controller.abort();
  }, [url, serverUrl]);

  return answer && answer.url === url ? (answer.use ?? url) : url;
}

export function useFileInfo(resource: Resource): FileInfo {
  const [serverDownloadUrl] = useString(
    resource,
    server.properties.downloadUrl,
  );
  const [mimeType] = useString(resource, server.properties.mimetype);
  const [bytes] = useNumber(resource, server.properties.filesize);
  // Local-first: when the browser already has the bytes (just-uploaded file,
  // offline, or anything cached in the WASM clientDb) prefer the in-memory
  // blob URL. The server `downloadURL` returns 404 immediately after upload
  // until the BLOB_RESPONSE round-trip completes — without this, the preview
  // would flash a broken image on its way to "loaded".
  const objectUrl = useFileObjectUrl(resource, serverDownloadUrl);
  const downloadUrl = useConnectedServerFallback(objectUrl);

  const downloadFile = useCallback(() => {
    // The URL is the resource's own claim; refuse anything that would run
    // rather than download.
    if (downloadUrl && isSafeHref(downloadUrl)) {
      window.open(downloadUrl);
    }
  }, [downloadUrl]);

  // A File that has not arrived (or arrived without its properties) is not
  // loaded yet: show the placeholder instead of throwing into an error page.
  if (
    resource.loading ||
    downloadUrl === undefined ||
    mimeType === undefined ||
    bytes === undefined
  ) {
    return {
      loading: true,
      downloadUrl: undefined,
      downloadFile,
      mimeType: undefined,
      bytes: undefined,
    };
  }

  return {
    loading: false,
    downloadFile,
    downloadUrl: downloadUrl!,
    bytes: bytes!,
    mimeType: mimeType!,
  };
}
