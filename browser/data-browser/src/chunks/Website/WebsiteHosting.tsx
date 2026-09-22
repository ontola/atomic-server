import { useCustomContextItems } from '@components/ResourceContextMenu';
import {
  Dialog,
  DialogTitle,
  DialogContent,
  useDialog,
} from '@components/Dialog';
import { useCallback, useMemo, useEffect, useRef, useState } from 'react';
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
  kind = 'site',
}: {
  project: string;
  draft?: WebsiteArtifact;
  canWrite: boolean;
  draftError?: string;
  savedDigest?: string;
  saveRelease: (artifact: WebsiteArtifact) => Promise<HostingStatus>;
  secondary?: boolean;
  kind?: 'site' | 'view';
}) {
  const store = useStore();
  const [dialogProps, showVersions] = useDialog();
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
            `Could not load publication status: ${error instanceof Error ? error.message : String(error)}`,
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

  const run = useCallback(
    async (action: () => Promise<void>) => {
      setBusy(true);

      try {
        await action();
      } catch (error) {
        store.notifyError(
          error instanceof Error ? error : new Error(String(error)),
        );
      }

      setBusy(false);
    },
    [store],
  );

  const activate = useCallback(
    async (deployment: string | null, current: HostingStatus) => {
      if (!current.state)
        throw new Error('No publication version is available.');
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
    },
    [store, project],
  );

  const menuItems = useMemo(
    () => [
      {
        id: 'publication-view',
        label: kind === 'view' ? 'Open published view' : 'View site',
        disabled: !status?.state?.active,
        onClick: () => {
          if (status?.state?.active)
            window.open(status.url, '_blank', 'noopener,noreferrer');
        },
      },
      {
        id: 'publication-versions',
        label: kind === 'view' ? 'View versions' : 'Website versions',
        helper: 'Preview, restore and inspect publication history',
        disabled: !status?.state?.deployments.length,
        onClick: showVersions,
      },
      {
        id: 'publication-unpublish',
        label: kind === 'view' ? 'Unpublish view' : 'Unpublish website',
        disabled: busy || !canWrite || !status?.state?.active,
        onClick: () => {
          if (status) void run(() => activate(null, status));
        },
      },
    ],
    [status, showVersions, busy, canWrite, run, activate, kind],
  );
  useCustomContextItems(menuItems);

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
          'Someone else changed this publication. Check the live version before updating again.',
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
                ? kind === 'view'
                  ? 'Update view'
                  : 'Update site'
                : kind === 'view'
                  ? 'Publish view'
                  : 'Publish site'}
        </Button>
        <Dialog {...dialogProps}>
          <DialogTitle>
            {kind === 'view' ? 'View versions' : 'Website versions'}
          </DialogTitle>
          <DialogContent>
            <p>
              Hosted on your Atomic Server. Updates publish the reviewed
              snapshot.
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
                href={
                  kind === 'view'
                    ? `${status.url}_releases/${previous}/`
                    : `/app/show?subject=${encodeURIComponent(project)}&view=website-version:${previous}`
                }
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
          </DialogContent>
        </Dialog>
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
`;
