import { useState } from 'react';
import { useStore, core } from '@tomic/react';
import { Button } from '@components/Button';
import { Column, Row } from '@components/Row';
import Field from '@components/forms/Field';
import { ErrMessage, Input } from '@components/forms/InputStyles';
import { BasicSelect } from '@components/forms/BasicSelect';
import { AtomicLink } from '@components/AtomicLink';
import { useIntegrationProxy } from '@helpers/integrationProxy';
import { readSavedConnection } from '../../../../../integrations/localthought/settings';
import type { SyncSession } from '../../../../../integrations/localthought/browser-sync';
import {
  discoverDatabases,
  proxyOperation,
} from '../../../../../integrations/notion/proxy';
import { run } from '../../../../../integrations/notion/plugin';
import source from '../../../../../integrations/notion/plugin.js?raw';
import type { Connection } from '../../../../../integrations/notion/atomic';
import {
  browserIntegrations,
  proxyRequest,
  type SavedConnection,
} from './localThought';
import {
  previewBrowserPlugin,
  applyBrowserPlugin,
  savedBrowserSync,
  type BrowserPlugin,
} from './browserPluginSync';
import { ConnectNotionManual } from './ConnectNotionManual';

export function ConnectNotion({
  drive,
  origin: suppliedOrigin,
}: {
  drive: string;
  origin?: string;
}) {
  const selectedOrigin = useIntegrationProxy();
  const origin = suppliedOrigin ?? selectedOrigin;
  const store = useStore();
  const actor = store.getAgent()?.subject ?? '';
  // Remount when identity/proxy changes so a previous account cannot remain selected.
  return (
    <NotionConnection
      key={JSON.stringify([drive, actor, origin])}
      drive={drive}
      actor={actor}
      origin={origin}
    />
  );
}
function NotionConnection({
  drive,
  actor,
  origin,
}: {
  drive: string;
  actor: string;
  origin: string;
}) {
  const messages = {
    loadMore: 'Load more databases',
    empty:
      'No databases found. Reconnect and grant access to the database in Notion.',
    preview: 'Preview sync',
    openTable: 'Open Notion table',
    syncTable: 'Sync this table',
    review:
      'Review these proposed changes to Atomic and Notion. Approving will apply supported edits in both directions.',
    uncertain:
      'A previous write has an uncertain result. Check the provider and saved run before continuing. It will not be sent again automatically.',
    approve: 'Approve and sync',
    close: 'Close preview',
    complete: 'Sync complete.',
    working: 'Working…',
  };
  const store = useStore();
  const [connection] = useState<SavedConnection | undefined>(() => {
    const raw = readSavedConnection(
      localStorage,
      origin,
      drive,
      actor,
      'notion',
    );
    return raw ? JSON.parse(raw) : undefined;
  });
  const installationKey = JSON.stringify([
    'notion-proxy-installations-v1',
    origin,
    drive,
    actor,
    connection?.connection,
  ]);
  const [installed, setInstalled] = useState<Record<string, Connection>>(() =>
    JSON.parse(localStorage.getItem(installationKey) ?? '{}'),
  );
  const [databases, setDatabases] = useState<
    { id: string; name: string; icon: string }[]
  >([]);
  const [database, setDatabase] = useState('');
  const [query, setQuery] = useState('');
  const [cursor, setCursor] = useState<string>();
  const [searched, setSearched] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [preview, setPreview] = useState<SyncSession>();
  const [active, setActive] = useState<Connection>();
  const [completed, setCompleted] = useState(false);
  const [labels, setLabels] = useState<Record<string, string>>({});
  const request = (path: string, init?: { method?: string; body?: string }) => {
    if (!connection) throw new Error('Connect Notion before continuing');
    return browserIntegrations(origin).request(
      drive,
      actor,
      connection.connection,
      'notion',
      path,
      init,
    );
  };
  const plugin = (config: Connection): BrowserPlugin => ({
    drive,
    plugin: config.plugin,
    config,
    source,
    run,
    read: proxyOperation(config.dataSource, request, 'read'),
    write: proxyOperation(config.dataSource, request, 'write'),
  });
  const attempt = async (action: () => Promise<void>) => {
    setBusy(true);
    setError('');
    try {
      await action();
    } catch (reason) {
      setError(String(reason));
    } finally {
      setBusy(false);
    }
  };
  const connect = () =>
    attempt(async () => {
      const result = await proxyRequest<{ url: string; state: string }>(
        store,
        'start',
        {
          drive,
          origin,
          platform: 'notion',
          returnUrl: `${location.origin}/app/integrations`,
        },
      );
      sessionStorage.setItem(
        'localthought-pending',
        JSON.stringify({
          state: result.state,
          origin,
          drive,
          actor,
          platform: 'notion',
        }),
      );
      location.assign(result.url);
    });
  const search = (more = false) =>
    attempt(async () => {
      const result = await discoverDatabases(
        request,
        query,
        more ? cursor : undefined,
      );
      setDatabases(previous =>
        more
          ? [
              ...previous,
              ...result.results.filter(r => !previous.some(p => p.id === r.id)),
            ]
          : result.results,
      );
      setCursor(result.cursor);
      setSearched(true);
      if (!more) setDatabase('');
    });
  const prepare = (existing?: Connection) =>
    attempt(async () => {
      if (!connection) throw new Error('Connect Notion before continuing');
      let config = existing ?? installed[database];
      if (!config) {
        const { installNotion } = await import('./notionInstaller');
        config = await installNotion(store, drive, database, {
          connection: connection.connection,
          origin,
          request,
        });
        const next = { ...installed, [database]: config };
        localStorage.setItem(installationKey, JSON.stringify(next));
        setInstalled(next);
      }
      setActive(config);
      setCompleted(false);
      setLabels(
        Object.fromEntries(
          await Promise.all(
            config.fields.map(async field => [
              field.id,
              String(
                (await store.getResource(field.property)).get(
                  core.properties.name,
                ) ?? field.id,
              ),
            ]),
          ),
        ),
      );
      const previous = savedBrowserSync(store, plugin(config));
      setPreview(
        previous && !previous.complete
          ? previous
          : await previewBrowserPlugin(store, plugin(config)),
      );
    });
  const apply = () =>
    attempt(async () => {
      if (!active || !preview) return;
      try {
        const result = await applyBrowserPlugin(store, plugin(active), preview);
        setPreview(undefined);
        setCompleted(!!result.complete);
      } catch (reason) {
        setPreview(savedBrowserSync(store, plugin(active)) ?? preview);
        throw reason;
      }
    });
  return (
    <Column gap='1rem'>
      <p>
        Connect Notion through the integration proxy, select a database, then
        review changes before syncing.
      </p>
      <p>
        Sync runs in this browser while it is open. Connection credentials stay
        in this browser. Existing server connections require reconnecting.
      </p>
      <Button disabled={busy} onClick={connect}>
        {connection ? 'Reconnect Notion' : 'Connect Notion'}
      </Button>
      {connection && (
        <>
          <form
            onSubmit={e => {
              e.preventDefault();
              void search();
            }}
          >
            <Column>
              <Field label='Find a database' fieldId='notion-search'>
                <Input
                  id='notion-search'
                  value={query}
                  disabled={busy}
                  onChange={e => {
                    setQuery(e.target.value);
                    setCursor(undefined);
                  }}
                />
              </Field>
              <Button type='submit' disabled={busy}>
                Find databases
              </Button>
            </Column>
          </form>
          {databases.length > 0 && (
            <Field label='Database' fieldId='notion-database'>
              <BasicSelect
                id='notion-database'
                value={database}
                disabled={busy}
                onChange={e => setDatabase(e.target.value)}
              >
                <option value=''>Choose a database</option>
                {databases.map(d => (
                  <option key={d.id} value={d.id}>
                    {d.icon} {d.name || 'Untitled database'}
                  </option>
                ))}
              </BasicSelect>
            </Field>
          )}
          {cursor && (
            <Button subtle disabled={busy} onClick={() => search(true)}>
              {messages.loadMore}
            </Button>
          )}
          {searched && !databases.length && <p>{messages.empty}</p>}
          <Button
            disabled={busy || !database || !!preview}
            onClick={() => prepare()}
          >
            {messages.preview}
          </Button>
          {Object.values(installed).map(config => (
            <Row key={config.plugin}>
              <AtomicLink subject={config.table}>
                {messages.openTable}
              </AtomicLink>
              <Button
                subtle
                disabled={busy || !!preview}
                onClick={() => prepare(config)}
              >
                {messages.syncTable}
              </Button>
            </Row>
          ))}
        </>
      )}
      {preview && (
        <Column>
          <p>{messages.review}</p>
          <NotionChanges
            proposal={preview.proposal}
            labels={labels}
            config={active}
          />
          {preview.pending ? (
            <ErrMessage role='alert'>{messages.uncertain}</ErrMessage>
          ) : (
            <Button disabled={busy} onClick={apply}>
              {messages.approve}
            </Button>
          )}
          <Button subtle disabled={busy} onClick={() => setPreview(undefined)}>
            {messages.close}
          </Button>
        </Column>
      )}
      {completed && <p>{messages.complete}</p>}
      {busy && <p aria-live='polite'>{messages.working}</p>}
      {error && <ErrMessage role='alert'>{error}</ErrMessage>}
      <details>
        <summary>Advanced setup with a token</summary>
        <ConnectNotionManual drive={drive} />
      </details>
    </Column>
  );
}

function NotionChanges({
  proposal,
  labels,
  config,
}: {
  proposal: unknown;
  labels: Record<string, string>;
  config?: Connection;
}) {
  const changes = (
    proposal as {
      changes: {
        kind: string;
        desired: Record<string, unknown>;
        local?: Record<string, unknown>;
        remote?: Record<string, unknown>;
      }[];
    }
  ).changes;
  const value = (field: string, raw: unknown) => {
    if (raw === undefined || raw === null) return '—';
    const options = config?.fields.find(f => f.id === field)?.optionNames;
    return Array.isArray(raw)
      ? raw.map(item => options?.[String(item)] ?? String(item)).join(', ')
      : String(raw);
  };
  return (
    <Column>
      {!changes.length && <p>Both sides are already up to date.</p>}
      {changes.map((change, i) => (
        <Column key={i}>
          <strong>
            {change.kind === 'page'
              ? 'Row'
              : change.kind === 'schema'
                ? 'Property name'
                : 'View'}
          </strong>
          <table>
            <thead>
              <tr>
                <th>Field</th>
                <th>Atomic</th>
                <th>Notion</th>
                <th>Proposed</th>
              </tr>
            </thead>
            <tbody>
              {Object.entries(change.desired).map(([field, desired]) => (
                <tr key={field}>
                  <td>{labels[field] ?? field}</td>
                  <td>{value(field, change.local?.[field])}</td>
                  <td>{value(field, change.remote?.[field])}</td>
                  <td>{value(field, desired)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Column>
      ))}
    </Column>
  );
}
