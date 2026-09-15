import { useEffect, useState } from 'react';
import styled from 'styled-components';
import {
  dataBrowser,
  useCanWrite,
  useStore,
  type Resource,
} from '@tomic/react';
import { Button } from '@components/Button';
import { Row, Column } from '@components/Row';
import { AtomicLink } from '@components/AtomicLink';
import Field from '@components/forms/Field';
import { InputStyled } from '@components/forms/InputStyles';
import { ResourceSelector } from '@components/forms/ResourceSelector';
import { useAISidebar, newContextItem } from '@components/AI/AISidebarContext';
import type { AIAtomicResourceMessageContext } from '@chunks/AI/types';
import { readWebsite, updateWebsite, type WebsiteConfig } from './websiteModel';
import {
  buildWebsiteArtifact,
  downloadWebsite,
  readWebsiteRelease,
  saveWebsiteRelease,
  selectedSubjects,
} from './websiteExport';
import type { WebsiteArtifact } from './renderWebsite';
import { WebsitePreview } from './WebsitePreview';
import { WebsiteInlinePreview } from './WebsiteInlinePreview';

export function WebsitePage({ resource }: { resource: Resource }) {
  const store = useStore();
  const drive = store.getDrive()!;
  const canWrite = useCanWrite(resource);
  const { askAI } = useAISidebar();
  const [config, setConfig] = useState<WebsiteConfig>();
  const [draft, setDraft] = useState<WebsiteArtifact>();
  const [release, setRelease] = useState<WebsiteArtifact>();
  const [inlineArtifact, setInlineArtifact] = useState<WebsiteArtifact>();
  const [review, setReview] = useState<WebsiteArtifact>();
  const [pagePath, setPagePath] = useState('/');
  const [showRelease, setShowRelease] = useState(false);
  const [problem, setProblem] = useState('');
  const [busy, setBusy] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const [document, setDocument] = useState<string>();

  useEffect(
    () => store.subscribe(resource.subject, () => setRefresh(n => n + 1)),
    [store, resource.subject],
  );
  useEffect(() => {
    let active = true;
    setDraft(undefined);
    setProblem('');
    readWebsite(store, drive, resource)
      .then(async result => {
        if (!active) return;
        setConfig(result.config);
        const [next, saved] = await Promise.all([
          buildWebsiteArtifact(store, resource.subject, result.config),
          readWebsiteRelease(store, drive, resource),
        ]);

        if (active) {
          setDraft(next);
          setRelease(saved);
        }
      })
      .catch(error => {
        if (active) setProblem(String(error));
      });

    return () => {
      active = false;
    };
  }, [store, drive, resource, refresh]);
  const subjects = config ? JSON.stringify(selectedSubjects(config)) : '[]';
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    const unsubs = (JSON.parse(subjects) as string[]).map(subject =>
      store.subscribe(subject, () => {
        clearTimeout(timer);
        timer = setTimeout(() => setRefresh(n => n + 1), 150);
      }),
    );

    return () => {
      clearTimeout(timer);
      unsubs.forEach(unsub => unsub());
    };
  }, [store, subjects]);

  const perform = async (action: () => Promise<unknown>) => {
    setBusy(true);
    setProblem('');

    try {
      await action();
    } catch (error) {
      setProblem(String(error));
    }

    setBusy(false);
  };

  const change = (next: WebsiteConfig) =>
    perform(async () => {
      await updateWebsite(store, drive, resource, next);
      setRefresh(n => n + 1);
    });
  const shown = review ?? (showRelease ? release : draft);
  const currentPage =
    config?.pages.find(page => page.path === pagePath) ?? config?.pages[0];
  const file = `${pagePath.slice(1)}index.html`;
  const html = shown?.files[file] ?? shown?.files['index.html'];

  return (
    <Workspace>
      <Row>
        <div>
          <h1>{config?.title ?? resource.title}</h1>
          <p role='status'>
            {release
              ? draft?.digest === release.digest
                ? 'Release ready'
                : 'Unreleased changes'
              : 'Draft'}
          </p>
        </div>
        <Button
          disabled={!canWrite}
          onClick={() =>
            askAI({
              prompt:
                /* @wc-ignore */ 'Help me design this website. Read it with describe_website, ask what I want to change, then use update_website. Keep content in its existing Atomic documents and tables.',
              context: [
                newContextItem<AIAtomicResourceMessageContext>({
                  type: 'atomic-resource',
                  subject: resource.subject,
                }),
              ],
            })
          }
        >
          Design with Assistant
        </Button>
        <Button
          disabled={!draft || !canWrite || busy}
          onClick={() => setReview(draft)}
        >
          Prepare release
        </Button>
      </Row>
      <p>
        Content stays in Atomic. Export a frozen website for static hosting.
        Online publishing is not connected yet.
      </p>
      {problem && <p role='alert'>{problem}</p>}
      {review && (
        <Review aria-label='Review website release'>
          <h2>Review release</h2>
          <p>
            This freezes the pages shown below. It does not make your website
            public.
          </p>
          <ul>
            {review.config.pages.map(page => (
              <li key={page.path}>
                {page.title}: {page.documents.length} documents,{' '}
                {page.tables.reduce((n, table) => n + table.rows.length, 0)}{' '}
                selected rows
              </li>
            ))}
          </ul>
          <Row>
            <Button
              disabled={busy}
              onClick={() =>
                perform(async () => {
                  await saveWebsiteRelease(store, drive, resource, review);
                  setRelease(review);
                  setReview(undefined);
                  setShowRelease(true);
                })
              }
            >
              Create release
            </Button>
            <Button subtle onClick={() => setReview(undefined)}>
              Cancel
            </Button>
          </Row>
        </Review>
      )}
      <Layout>
        <Controls>
          <h2>Pages and content</h2>
          {config && (
            <Field label='Page' fieldId='website-page'>
              <select
                id='website-page'
                value={pagePath}
                onChange={event => setPagePath(event.target.value)}
              >
                {config.pages.map(page => (
                  <option key={page.path} value={page.path}>
                    {page.title}
                  </option>
                ))}
              </select>
            </Field>
          )}
          {currentPage?.documents.map(subject => (
            <AtomicLink key={subject} subject={subject}>
              Edit document
            </AtomicLink>
          ))}
          {currentPage?.tables.map(table => (
            <AtomicLink key={table.table} subject={table.table}>
              {table.title}
            </AtomicLink>
          ))}
          {canWrite && (
            <>
              <Field label='Add a document' fieldId='website-document'>
                <ResourceSelector
                  id='website-document'
                  isA={dataBrowser.classes.documentV2}
                  value={document}
                  setSubject={setDocument}
                  hideCreateOption
                />
              </Field>
              <Button
                disabled={!document || !config || busy}
                onClick={() => {
                  if (!document || !config || !currentPage) return;
                  void change({
                    ...config,
                    pages: config.pages.map(page =>
                      page.path === currentPage.path
                        ? {
                            ...page,
                            documents: [
                              ...new Set([...page.documents, document]),
                            ],
                          }
                        : page,
                    ),
                  });
                  setDocument(undefined);
                }}
              >
                Add to page
              </Button>
            </>
          )}
          {config && (
            <>
              <h2>Design</h2>
              <Field label='Accent color' fieldId='website-accent'>
                <InputStyled
                  id='website-accent'
                  type='color'
                  value={config.accent}
                  disabled={!canWrite || busy}
                  onChange={event =>
                    void change({ ...config, accent: event.target.value })
                  }
                />
              </Field>
              <Field label='Typography' fieldId='website-font'>
                <select
                  id='website-font'
                  value={config.font}
                  disabled={!canWrite || busy}
                  onChange={event =>
                    void change({
                      ...config,
                      font: event.target.value as WebsiteConfig['font'],
                    })
                  }
                >
                  <option value='serif'>Editorial</option>
                  <option value='sans'>Modern</option>
                </select>
              </Field>
            </>
          )}
          <h2>Release</h2>
          {release ? (
            <>
              <Button subtle onClick={() => setShowRelease(!showRelease)}>
                {showRelease ? 'Show draft' : 'Show release'}
              </Button>
              <Button
                disabled={busy}
                onClick={() => perform(() => downloadWebsite(release))}
              >
                Download website
              </Button>
            </>
          ) : (
            <p>No release yet.</p>
          )}
        </Controls>
        <Preview>
          <p>
            {review
              ? 'Release review'
              : showRelease
                ? 'Frozen release'
                : 'Live draft preview'}
          </p>
          {!review && !showRelease && (
            <Button
              disabled={!draft || busy}
              onClick={() =>
                setInlineArtifact(inlineArtifact ? undefined : draft)
              }
            >
              {inlineArtifact ? 'Done editing' : 'Edit on page'}
            </Button>
          )}
          {!review &&
          !showRelease &&
          inlineArtifact?.project === resource.subject ? (
            <WebsiteInlinePreview
              key={`${inlineArtifact.digest}:${pagePath}`}
              artifact={inlineArtifact}
              pagePath={pagePath}
            />
          ) : html && (showRelease || review) ? (
            <iframe title='Website preview' sandbox='' srcDoc={html} />
          ) : html ? (
            <WebsitePreview
              key={`${shown!.digest}:${pagePath}`}
              artifact={shown!}
              pagePath={pagePath}
              onNavigate={setPagePath}
            />
          ) : (
            <p>Preparing preview…</p>
          )}
        </Preview>
      </Layout>
    </Workspace>
  );
}

const Workspace = styled.div`
  padding: ${p => p.theme.size(2)};
  h1 {
    margin: 0;
  }
  p {
    line-height: 1.5;
  }
`;
const Layout = styled.div`
  display: grid;
  grid-template-columns: 260px minmax(0, 1fr);
  gap: 2rem;
  @media (max-width: 800px) {
    grid-template-columns: 1fr;
  }
`;
const Controls = styled(Column)`
  gap: 1rem;
  h2 {
    font-size: 1rem;
    margin: 1rem 0 0;
  }
  select {
    width: 100%;
    padding: 0.6rem;
  }
`;
const Preview = styled.div`
  min-width: 0;
  iframe {
    width: 100%;
    height: 75vh;
    border: 1px solid ${p => p.theme.colors.bg2};
    border-radius: 12px;
    background: white;
  }
`;
const Review = styled.section`
  padding: 1.5rem;
  margin: 1rem 0;
  border: 1px solid ${p => p.theme.colors.main};
  border-radius: 12px;
`;
