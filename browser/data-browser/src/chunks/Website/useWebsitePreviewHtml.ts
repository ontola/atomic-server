import { useEffect, useState } from 'react';
import { useStore } from '@tomic/react';
import type { WebsiteArtifact } from './renderWebsite';
import { readWebsiteAsset } from './websiteAssets';

/** Blob URLs are transient preview handles, never stored in HTML releases. */
export function useWebsitePreviewHtml(html: string, artifact: WebsiteArtifact) {
  const store = useStore();
  const [resolved, setResolved] = useState<{ html: string; result: string }>();
  const [failure, setFailure] = useState<{ html: string; message: string }>();
  const [attempt, setAttempt] = useState(0);
  const project = artifact.project;
  const assetsKey = JSON.stringify(artifact.assets ?? {});
  useEffect(() => {
    let cancelled = false;
    const urls: string[] = [];
    void (async () => {
      let result = html;

      for (const [path, asset] of Object.entries(
        JSON.parse(assetsKey) as NonNullable<WebsiteArtifact['assets']>,
      )) {
        const blob = await readWebsiteAsset(store, project, asset);
        if (cancelled) return;
        const url = URL.createObjectURL(blob);
        urls.push(url);
        result = result.replaceAll(`src="/${path}"`, `src="${url}"`);
      }

      if (!cancelled) {
        setResolved({ html, result });
        setFailure(undefined);
      }
    })().catch(error => {
      if (!cancelled) {
        const cause = new Error(
          `Website preview assets failed: ${String(error)}`,
          { cause: error },
        );
        setFailure({ html, message: cause.message });
        store.notifyError(cause);
      }
    });

    return () => {
      cancelled = true;
      urls.forEach(url => URL.revokeObjectURL(url));
    };
  }, [store, html, project, assetsKey, attempt]);

  return {
    html: resolved?.html === html ? resolved.result : '',
    error: failure?.html === html ? failure.message : undefined,
    retry: () => setAttempt(n => n + 1),
  };
}
