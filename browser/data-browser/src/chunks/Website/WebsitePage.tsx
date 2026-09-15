import { useEffect, useRef, useState } from 'react';
import styled from 'styled-components';
import {
  dataBrowser,
  useCanWrite,
  useResource,
  useStore,
  type Resource,
} from '@tomic/react';
import { Button } from '@components/Button';
import { Row, Column } from '@components/Row';
import { AtomicLink } from '@components/AtomicLink';
import Field from '@components/forms/Field';
import { FaRegFileLines, FaTable, FaPlus, FaImage } from 'react-icons/fa6';
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
import { WebsiteHosting } from './WebsiteHosting';
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
  const reportedProblem = useRef('');
  const [busy, setBusy] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const [document, setDocument] = useState<string>();
  const [addingContent, setAddingContent] = useState(false);

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
          reportedProblem.current = '';
          setDraft(next);
          setRelease(saved);
        }
      })
      .catch(error => {
        if (!active) return;
        const failure = new Error(
          `Website preview failed: ${error instanceof Error ? error.message : String(error)}`,
          { cause: error },
        );
        setProblem(failure.message);

        if (reportedProblem.current !== failure.message) {
          reportedProblem.current = failure.message;
          store.notifyError(failure);
        }
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

    try {
      await action();
    } catch (error) {
      store.notifyError(
        error instanceof Error ? error : new Error(String(error)),
      );
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
      <Header>
        <Title>
          <h1>{config?.title ?? resource.title}</h1>
          <p>Changes stay private until you publish.</p>
        </Title>
        <Row>
          <Button
            subtle
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
            Design with AI
          </Button>
          <WebsiteHosting
            key={resource.subject}
            project={resource.subject}
            draft={draft}
            canWrite={!!canWrite}
            secondary={!!review}
            saveRelease={async artifact => {
              await saveWebsiteRelease(store, drive, resource, artifact);
              setRelease(artifact);
            }}
          >
            <>
              <h3>Export</h3>
              <Button
                subtle
                disabled={!draft || !canWrite || busy}
                onClick={() => {
                  setReview(draft);
                }}
              >
                Prepare release
              </Button>
              {release ? (
                <>
                  <Button subtle onClick={() => setShowRelease(!showRelease)}>
                    {showRelease ? 'Show draft' : 'Show release'}
                  </Button>
                  <Button
                    subtle
                    disabled={busy}
                    onClick={() =>
                      perform(() => downloadWebsite(release, store))
                    }
                  >
                    Download website
                  </Button>
                </>
              ) : (
                <p>No release yet.</p>
              )}
            </>
          </WebsiteHosting>
        </Row>
      </Header>
      {problem && (
        <div role='alert'>
          <p>{problem}</p>
          <p>
            Publishing is unavailable until the draft preview can be built.
            Check access to the selected content, then retry.
          </p>
          <Button
            subtle
            onClick={() => {
              reportedProblem.current = '';
              setRefresh(n => n + 1);
            }}
          >
            Retry preview
          </Button>
        </div>
      )}
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
              data-website-primary
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
          <h2>Content</h2>
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
            <ContentSource key={subject} subject={subject} kind='document' />
          ))}
          {currentPage?.tables.map(table => (
            <ContentSource
              key={table.table}
              subject={table.table}
              kind='table'
            />
          ))}
          {currentPage?.media?.map(media => (
            <ContentSource
              key={media.subject}
              subject={media.subject}
              kind='image'
            />
          ))}
          {canWrite && (
            <>
              <Button
                subtle
                onClick={() => setAddingContent(true)}
                disabled={addingContent}
              >
                <FaPlus aria-hidden /> Add content
              </Button>
              {addingContent && (
                <Column>
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
                    subtle
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
                      setAddingContent(false);
                    }}
                  >
                    Add to page
                  </Button>
                  <Button subtle onClick={() => setAddingContent(false)}>
                    Cancel
                  </Button>
                </Column>
              )}
            </>
          )}
        </Controls>
        <Preview>
          <PreviewToolbar>
            <p>
              {review
                ? 'Release review'
                : showRelease
                  ? 'Frozen release'
                  : 'Live draft preview'}
            </p>
            {!review && !showRelease && (
              <Button
                subtle
                disabled={!draft || busy}
                onClick={() =>
                  setInlineArtifact(inlineArtifact ? undefined : draft)
                }
              >
                {inlineArtifact ? 'Done editing' : 'Edit on page'}
              </Button>
            )}
          </PreviewToolbar>
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
            <p>
              {problem
                ? 'Preview unavailable. Resolve the error above and retry.'
                : 'Preparing preview…'}
            </p>
          )}
        </Preview>
      </Layout>
    </Workspace>
  );
}

function ContentSource({
  subject,
  kind,
}: {
  subject: string;
  kind: 'document' | 'table' | 'image';
}) {
  const source = useResource(subject);

  return (
    <SourceLink subject={subject} clean>
      {kind === 'image' ? (
        <FaImage aria-hidden />
      ) : kind === 'table' ? (
        <FaTable aria-hidden />
      ) : (
        <FaRegFileLines aria-hidden />
      )}
      <span>
        <strong>{source.title}</strong>
        <small>
          {kind === 'table' ? 'Table' : kind === 'image' ? 'Image' : 'Document'}
        </small>
      </span>
    </SourceLink>
  );
}

const SourceLink = styled(AtomicLink)`
  display: flex;
  align-items: center;
  gap: 0.65rem;
  padding: 0.6rem;
  border-radius: ${p => p.theme.radius};
  color: inherit;
  text-decoration: none;
  &:hover {
    background: ${p => p.theme.colors.bg1};
  }
  > svg {
    flex-shrink: 0;
    color: ${p => p.theme.colors.textLight};
  }
  span {
    min-width: 0;
  }
  strong {
    display: block;
    font-weight: 500;
    overflow-wrap: anywhere;
  }
  small {
    display: block;
    color: ${p => p.theme.colors.textLight};
  }
`;

const Workspace = styled.div`
  padding: ${p => p.theme.size(3)};
  width: 100%;
  min-width: 0;
  box-sizing: border-box;
  h1 {
    margin: 0;
  }
  p {
    line-height: 1.5;
  }
`;
const Layout = styled.div`
  display: grid;
  grid-template-columns: 220px minmax(0, 1fr);
  gap: 1.5rem;
  @media (max-width: 800px) {
    grid-template-columns: 1fr;
  }
`;
const Controls = styled(Column)`
  @media (max-width: 800px) {
    order: 2;
  }
  gap: 1rem;
  min-width: 0;
  font-size: 0.9rem;
  details {
    border-top: 1px solid ${p => p.theme.colors.bg2};
    padding-top: 1rem;
  }
  summary {
    cursor: pointer;
    font-weight: 600;
    margin-bottom: 1rem;
  }
  details > button {
    margin-top: 0.75rem;
  }
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
    height: 76vh;
    display: block;
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

const Header = styled.header`
  button,
  a {
    font: inherit;
    line-height: 1.25;
  }
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 1rem;
  flex-wrap: wrap;
  margin-bottom: 1.5rem;
  > div:last-child {
    flex-wrap: wrap;
  }
`;
const Title = styled.div`
  min-width: 0;
  flex: 1 1 260px;
  h1 {
    font-size: clamp(1.25rem, 2.3vw, 1.8rem);
    overflow-wrap: anywhere;
    line-height: 1.2;
  }
  p {
    font-size: 0.85rem;
    opacity: 0.65;
    margin: 0.4rem 0 0;
  }
`;
const PreviewToolbar = styled.div`
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 1rem;
  min-height: 2.5rem;
  margin-bottom: 0.75rem;
  p {
    margin: 0;
    font-size: 0.85rem;
    opacity: 0.7;
  }
`;
