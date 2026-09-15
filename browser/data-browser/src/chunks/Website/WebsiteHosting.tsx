import { useEffect, useRef, useState, type ReactNode } from 'react';
import styled from 'styled-components';
import { useStore } from '@tomic/react';
import { Button, ButtonSubtle } from '@components/Button';
import Field from '@components/forms/Field';
import type { WebsiteArtifact } from './renderWebsite';
import {
  hostingRequest,
  sameWebsiteOutput,
  type WebsitePackage,
  type HostingStatus,
} from './hostingClient';

export function WebsiteHosting({
  project,
  draft,
  canWrite,
  draftError,
  savedDigest,
  saveRelease,
  secondary = false,
  children,
}: {
  project: string;
  draft?: WebsiteArtifact;
  canWrite: boolean;
  draftError?: string;
  savedDigest?: string;
  saveRelease: (artifact: WebsiteArtifact) => Promise<HostingStatus>;
  secondary?: boolean;
  children?: ReactNode;
}) {
  const store = useStore();
  const [status, setStatus] = useState<HostingStatus>();
  const [published, setPublished] = useState<{
    id: string;
    package: WebsitePackage;
  }>();
  const publishedCache = useRef<
    { id: string; package: WebsitePackage } | undefined
  >(undefined);
  const [busy, setBusy] = useState(false);
  const [previous, setPrevious] = useState('');
  const [statusError, setStatusError] = useState('');
  const reportedStatusError = useRef('');
  useEffect(() => {
    if (busy) return;
    let active = true;
    let sequence = 0;

    const refresh = () => {
      const request = ++sequence;
      hostingRequest<HostingStatus>(store, project)
        .then(async value => {
          const id = value.state?.active;
          const snapshot = id
            ? publishedCache.current?.id === id
              ? publishedCache.current
              : {
                  id,
                  package: await hostingRequest<WebsitePackage>(
                    store,
                    project,
                    `/preview/${id}`,
                  ),
                }
            : undefined;

          if (active && request === sequence) {
            publishedCache.current = snapshot;
            setPublished(snapshot);
            setStatus(value);
            setStatusError('');
            reportedStatusError.current = '';
          }
        })
        .catch(error => {
          if (!active || request !== sequence) return;
          const failure = new Error(
            `Could not load website hosting status: ${error instanceof Error ? error.message : String(error)}`,
            { cause: error },
          );
          setStatusError(failure.message);

          if (reportedStatusError.current !== failure.message) {
            reportedStatusError.current = failure.message;
            store.notifyError(failure);
          }
        });
    };

    refresh();
    window.addEventListener('focus', refresh);

    return () => {
      active = false;
      window.removeEventListener('focus', refresh);
    };
  }, [store, project, busy, savedDigest]);

  const run = async (action: () => Promise<void>) => {
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

  const activate = async (
    deployment: string | null,
    current: HostingStatus,
  ) => {
    if (!current.state) throw new Error('No website version is available.');
    const next = await hostingRequest<HostingStatus>(
      store,
      project,
      '/activate',
      {
        expectedRevision: current.state.revision,
        deployment,
      },
    );
    setStatus(next);
  };

  const publish = () =>
    run(async () => {
      if (!draft) return;
      const snapshot = draft;
      const before =
        status ?? (await hostingRequest<HostingStatus>(store, project));
      const uploaded = await saveRelease(snapshot);
      setStatus(uploaded);
      const alreadyUploaded = before.state?.deployments.includes(
        uploaded.deployment!,
      );
      const expected =
        (before.state?.revision ?? 0) + (alreadyUploaded ? 0 : 1);

      if (uploaded.state?.revision !== expected) {
        throw new Error(
          'Someone else changed this website. Check the live site before updating again.',
        );
      }

      await activate(uploaded.deployment!, uploaded);
    });

  const currentPackage: WebsitePackage | undefined = draft && {
    version: 1,
    files: draft.files,
    assets: Object.fromEntries(
      Object.entries(draft.assets ?? {}).map(([path, asset]) => [
        path,
        asset.hash,
      ]),
    ),
  };
  const live = status?.state?.active;
  const checking = !status || !draft || (!!live && published?.id !== live);
  const upToDate =
    !!live &&
    !checking &&
    !!currentPackage &&
    !!published &&
    sameWebsiteOutput(currentPackage, published.package);
  const unavailable = !!draftError || !!statusError;

  return (
    <Actions>
      <ActionRow>
        {status?.state?.active && (
          <SiteLink as='a' href={status.url} target='_blank' rel='noreferrer'>
            View site
          </SiteLink>
        )}
        <Button
          subtle={secondary || upToDate || checking || unavailable}
          data-website-primary={
            !secondary && !upToDate && !checking && !unavailable
              ? true
              : undefined
          }
          disabled={busy || !canWrite || checking || upToDate || unavailable}
          onClick={publish}
        >
          {busy
            ? 'Publishing…'
            : upToDate
              ? 'Up to date'
              : status?.state?.active
                ? 'Update site'
                : 'Publish site'}
        </Button>
        <details>
          <summary aria-label='Publishing options'>•••</summary>
          <Settings>
            <h3>Publishing</h3>
            <p>
              Hosted on your Atomic Server. Updates publish the current draft.
            </p>
            {!!status?.state?.deployments.length && (
              <Field label='Previous version' fieldId='hosting-release'>
                <select
                  id='hosting-release'
                  value={previous}
                  onChange={event => setPrevious(event.target.value)}
                >
                  <option value=''>Choose a version</option>
                  {status.state.deployments.map((id, index) => (
                    <option key={id} value={id}>
                      Version {index + 1}
                      {id === status.state?.active ? ' (live)' : ''}
                    </option>
                  ))}
                </select>
              </Field>
            )}
            {previous && status?.state?.versions?.[previous] && (
              <SiteLink
                as='a'
                href={`/app/show?subject=${encodeURIComponent(project)}&view=website-version:${previous}`}
              >
                Preview version
              </SiteLink>
            )}
            <Button
              subtle
              disabled={busy || !previous || !canWrite}
              onClick={() =>
                run(async () => {
                  if (status) await activate(previous, status);
                })
              }
            >
              Restore version
            </Button>
            {status?.state?.active && (
              <Button
                subtle
                disabled={busy || !canWrite}
                onClick={() => run(() => activate(null, status))}
              >
                Unpublish website
              </Button>
            )}
            {!!status?.state?.history.length && (
              <details>
                <summary>Publication history</summary>
                <ol>
                  {status.state.history
                    .slice()
                    .reverse()
                    .map((entry, index) => (
                      <li key={index}>
                        {new Date(entry.at).toLocaleString()}:{' '}
                        {entry.deployment
                          ? `Version ${status.state!.deployments.indexOf(entry.deployment) + 1}`
                          : 'Unpublished'}
                      </li>
                    ))}
                </ol>
              </details>
            )}
            {children}
          </Settings>
        </details>
      </ActionRow>
      <p role='status'>
        {busy
          ? 'Publishing…'
          : unavailable
            ? 'Cannot check changes'
            : checking
              ? 'Checking changes…'
              : upToDate
                ? 'All changes are published'
                : live
                  ? 'Unpublished changes'
                  : 'Not published yet'}
      </p>
      {statusError ? <p role='alert'>{statusError}</p> : null}
    </Actions>
  );
}

const SiteLink = styled(ButtonSubtle)`
  text-decoration: none;
`;

const Actions = styled.div`
  position: relative;
  > p {
    font-size: 0.85rem;
    max-width: 360px;
    margin: 0.5rem 0 0;
  }
`;
const ActionRow = styled.div`
  display: flex;
  align-items: center;
  gap: 0.8rem;
  > a {
    white-space: nowrap;
  }
  > details > summary {
    cursor: pointer;
    list-style: none;
    padding: 0.5rem;
  }
`;
const Settings = styled.div`
  position: absolute;
  z-index: 20;
  right: 0;
  top: 3rem;
  width: min(330px, 85vw);
  max-height: 75vh;
  overflow-y: auto;
  padding: 1.25rem;
  border-radius: 12px;
  background: ${p => p.theme.colors.bg};
  border: 1px solid ${p => p.theme.colors.bg2};
  box-shadow: 0 8px 30px #0002;
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
  h3,
  p {
    margin: 0;
  }
  p {
    font-size: 0.85rem;
    line-height: 1.5;
  }
  select {
    max-width: 100%;
  }
`;
