import { useEffect, useState } from 'react';
import { useStore } from '@tomic/react';
import type { WebsiteArtifact } from './renderWebsite';
import { readWebsiteAsset } from './websiteAssets';

/** Blob URLs are transient preview handles, never stored in HTML releases. */
export function useWebsitePreviewHtml(html: string, artifact: WebsiteArtifact) {
  const store = useStore();
  const [resolved, setResolved] = useState<{ html: string; result: string }>();
  useEffect(() => {
    let cancelled = false;
    const urls: string[] = [];
    void (async () => {
      let result = html;

      for (const [path, asset] of Object.entries(artifact.assets ?? {})) {
        const blob = await readWebsiteAsset(store, artifact.project, asset);
        if (cancelled) return;
        const url = URL.createObjectURL(blob);
        urls.push(url);
        result = result.replaceAll(`src="/${path}"`, `src="${url}"`);
      }

      if (!cancelled) setResolved({ html, result });
    })().catch(error => {
      if (!cancelled) store.notifyError(error);
    });

    return () => {
      cancelled = true;
      urls.forEach(url => URL.revokeObjectURL(url));
    };
  }, [store, html, artifact]);

  return resolved?.html === html ? resolved.result : '';
}
