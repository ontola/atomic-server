import { useEffect, useState } from 'react';
import styled from 'styled-components';
import { useStore, type Resource } from '@tomic/react';
import { AtomicLink } from '@components/AtomicLink';
import { Button } from '@components/Button';
import {
  readWebsiteExport,
  readWebsiteVersion,
  downloadWebsite,
} from './websiteExport';
import type { WebsiteArtifact } from './renderWebsite';
import { WebsitePreview } from './WebsitePreview';

export function WebsiteExportPage({
  resource,
  deployment,
}: {
  resource: Resource;
  deployment?: string;
}) {
  const store = useStore();
  const [artifact, setArtifact] = useState<WebsiteArtifact>();
  const [error, setError] = useState('');
  const [pagePath, setPagePath] = useState('/');
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let active = true;
    setArtifact(undefined);
    setError('');
    (deployment
      ? readWebsiteVersion(store, resource.subject, deployment)
      : readWebsiteExport(store, store.getDrive()!, resource)
    )
      .then(result => {
        if (active) setArtifact(result);
      })
      .catch(cause => {
        if (!active) return;
        setError(String(cause));
        store.notifyError(
          cause instanceof Error ? cause : new Error(String(cause)),
        );
      });

    return () => {
      active = false;
    };
  }, [store, resource, deployment, attempt]);

  return (
    <Page>
      {artifact ? (
        <>
          <header>
            <div>
              <h1>{artifact.config.title}</h1>
              <p>
                Saved version · {new Date(artifact.createdAt).toLocaleString()}
              </p>
            </div>
            <nav aria-label='Export actions'>
              <AtomicLink subject={artifact.project}>
                Back to app
              </AtomicLink>
              <select
                aria-label='Preview page'
                value={pagePath}
                onChange={event => setPagePath(event.target.value)}
              >
                {artifact.config.pages.map(page => (
                  <option key={page.path} value={page.path}>
                    {page.title}
                  </option>
                ))}
              </select>
              <Button
                subtle
                onClick={() => {
                  void downloadWebsite(artifact, store).catch(cause =>
                    store.notifyError(cause),
                  );
                }}
              >
                Download app
              </Button>
            </nav>
          </header>
          <WebsitePreview
            artifact={artifact}
            pagePath={pagePath}
            onNavigate={setPagePath}
            frozen
          />
        </>
      ) : error ? (
        <div role='alert'>
          <p>{error}</p>
          <Button subtle onClick={() => setAttempt(n => n + 1)}>
            Retry preview
          </Button>
        </div>
      ) : (
        <p>Loading saved preview…</p>
      )}
    </Page>
  );
}

const Page = styled.div`
  width: 100%;
  padding: 1rem;
  box-sizing: border-box;
  header,
  nav {
    display: flex;
    align-items: center;
    gap: 1rem;
    flex-wrap: wrap;
  }
  header {
    justify-content: space-between;
    margin-bottom: 1rem;
  }
  h1 {
    font-size: 1.25rem;
    margin: 0;
  }
  p {
    color: ${p => p.theme.colors.textLight};
    margin: 0.35rem 0;
  }
  select {
    padding: 0.5rem;
  }
  iframe {
    display: block;
    width: 100%;
    height: calc(100dvh - 180px);
    min-height: 400px;
    border: 1px solid ${p => p.theme.colors.bg2};
    border-radius: ${p => p.theme.radius};
    background: white;
  }
`;
