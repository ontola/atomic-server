import { useState } from 'react';
import { useStore } from '@tomic/react';
import { Button } from '@components/Button';
import { Row } from '@components/Row';
import Field from '@components/forms/Field';
import type { WebsiteArtifact } from './renderWebsite';
import {
  hostingRequest,
  type HostingStatus,
  type WebsitePackage,
} from './hostingClient';

/** Explicit upload/review/activation, separate from source editing and private release creation. */
export function WebsiteHosting({
  project,
  release,
  canWrite,
}: {
  project: string;
  release?: WebsiteArtifact;
  canWrite: boolean;
}) {
  const store = useStore();
  const [status, setStatus] = useState<HostingStatus>();
  const [candidate, setCandidate] = useState<string>();
  const [preview, setPreview] = useState<WebsitePackage>();
  const [page, setPage] = useState('index.html');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState('');

  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    setProblem('');

    try {
      await action();
    } catch (error) {
      setProblem(String(error));
    }

    setBusy(false);
  };

  const review = async (id: string) => {
    setPreview(undefined);
    setCandidate(undefined);
    const uploaded = await hostingRequest<WebsitePackage>(
      store,
      project,
      `/preview/${id}`,
    );
    setPreview(uploaded);
    setCandidate(id);
    setPage('index.html');
  };

  const activate = async (deployment: string | null) => {
    if (!status?.state) return;
    const next = await hostingRequest<HostingStatus>(
      store,
      project,
      '/activate',
      {
        expectedRevision: status.state.revision,
        deployment,
      },
    );
    setStatus(next);
    setCandidate(undefined);
    setPreview(undefined);
  };

  return (
    <section aria-label='Website hosting'>
      <h2>Publish on your Atomic Server</h2>
      <p>
        Upload a saved release, review it, then publish. Editing content leaves
        the live website unchanged.
      </p>
      <Row>
        <Button
          disabled={busy || !canWrite}
          onClick={() =>
            run(async () => {
              setStatus(await hostingRequest<HostingStatus>(store, project));
              setCandidate(undefined);
              setPreview(undefined);
            })
          }
        >
          Refresh hosting status
        </Button>
        <Button
          disabled={busy || !canWrite || !release}
          onClick={() =>
            run(async () => {
              const uploaded = await hostingRequest<HostingStatus>(
                store,
                project,
                '/deployments',
                { version: 1, files: release!.files },
              );
              setStatus(uploaded);
              await review(uploaded.deployment!);
            })
          }
        >
          Upload saved release
        </Button>
      </Row>
      {problem && <p role='alert'>{problem}</p>}
      {status && (
        <div>
          <p role='status'>
            {status.state?.active
              ? 'Website is live'
              : 'Website is not published'}
          </p>
          {status.state?.active && (
            <p>
              <a href={status.url} target='_blank' rel='noreferrer'>
                Open website
              </a>
            </p>
          )}
          {status.state?.active && (
            <Button
              disabled={busy || !canWrite}
              onClick={() => run(() => activate(null))}
            >
              Unpublish website
            </Button>
          )}
          {!!status.state?.deployments.length && (
            <Field label='Review an uploaded release' fieldId='hosting-release'>
              <select
                id='hosting-release'
                disabled={busy}
                value={candidate ?? ''}
                onChange={event => {
                  const id = event.target.value;
                  if (id) run(() => review(id));
                }}
              >
                <option value=''>Select a release</option>
                {status.state.deployments.map((id, index) => (
                  <option key={id} value={id}>
                    Release {index + 1}
                    {id === status.state?.active ? ' (live)' : ''}
                  </option>
                ))}
              </select>
            </Field>
          )}
        </div>
      )}
      {preview && candidate && (
        <div>
          <h3>Review before publishing</h3>
          <p>
            These uploaded pages will become publicly accessible. This preview
            disables scripts.
          </p>
          <select
            aria-label='Preview uploaded page'
            value={page}
            onChange={event => setPage(event.target.value)}
          >
            {Object.keys(preview.files)
              .filter(path => path.endsWith('index.html'))
              .map(path => (
                <option key={path}>{path}</option>
              ))}
          </select>
          <iframe
            title='Uploaded website preview'
            sandbox=''
            srcDoc={`<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'">${preview.files[page]}`}
            style={{ width: '100%', height: 400, border: 0 }}
          />
          <Button
            disabled={busy || !canWrite}
            onClick={() => run(() => activate(candidate))}
          >
            Publish reviewed release
          </Button>
        </div>
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
                    ? `Release ${status.state!.deployments.indexOf(entry.deployment) + 1}`
                    : 'Unpublished'}
                </li>
              ))}
          </ol>
        </details>
      )}
    </section>
  );
}
