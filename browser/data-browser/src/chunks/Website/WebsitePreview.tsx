import { useWebsitePreviewHtml } from './useWebsitePreviewHtml';
import { useEffect, useRef } from 'react';
import searchViewUrl from './runtime/search-view.html?url';
import { hostSnapshot } from './runtime/snapshotHost';
import type { WebsiteArtifact } from './renderWebsite';

/** Trusted generated page shell, with null-origin plugin views hosted by FrameBridge. */
export function WebsitePreview({
  artifact,
  pagePath,
  onNavigate,
}: {
  artifact: WebsiteArtifact;
  pagePath: string;
  onNavigate(path: string): void;
}) {
  const cleanups = useRef<(() => void)[]>([]);
  useEffect(() => () => cleanups.current.forEach(close => close()), []);
  const html = (
    artifact.files[`${pagePath.slice(1)}index.html`] ??
    artifact.files['index.html']
  ).replace('<script src="website-runtime.js" defer></script>', '');

  const previewHtml = useWebsitePreviewHtml(html, artifact);

  return (
    <iframe
      title='Website preview'
      sandbox='allow-same-origin allow-scripts'
      srcDoc={previewHtml}
      onLoad={event => {
        cleanups.current.forEach(close => close());
        cleanups.current = [];
        const doc = event.currentTarget.contentDocument;
        if (!doc) return;
        doc.addEventListener('click', click => {
          const link = (click.target as Element).closest('a');
          if (!link) return;
          click.preventDefault();
          const href = link.getAttribute('href');
          const page = artifact.config.pages.find(
            candidate => `${candidate.path.slice(1)}index.html` === href,
          );
          if (page) onNavigate(page.path);
        });

        for (const frame of doc.querySelectorAll<HTMLIFrameElement>(
          'iframe[data-snapshot]',
        )) {
          const snapshot = doc.getElementById(frame.dataset.snapshot!);
          if (!snapshot) continue;
          const bridge = hostSnapshot(frame, JSON.parse(snapshot.textContent!));
          cleanups.current.push(() => bridge.close());
          const url = new URL(searchViewUrl, window.location.href);
          url.searchParams.set('host', 'top');
          frame.src = url.href;
        }
      }}
    />
  );
}
