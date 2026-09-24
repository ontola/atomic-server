import { useEffect, useId, useState } from 'react';
import {
  core,
  dataBrowser,
  ensureSchema,
  executeServerPlugin,
  pluginConfigFor,
  pluginConfigProblems,
  useStore,
  DEFAULT_ACCEPT_MAX_BYTES,
  type DeclaredAccept,
  type DeclaredDestination,
  type JSONObject,
  type PluginManifest,
  type Resource,
  type SchemaSpec,
  type Store,
} from '@tomic/react';
import { Button } from '@components/Button';
import { Column } from '@components/Row';
import Field from '@components/forms/Field';
import { Input, ErrMessage } from '@components/forms/InputStyles';
import { AtomicLink } from '@components/AtomicLink';
import { pluginClassesFor } from './runScript';
import { RunPluginDialog } from './RunPluginDialog';

/**
 * The generic entry point for a plugin that declares `accepts`: choose a file,
 * preview what the plugin proposes for it, approve.
 *
 * The host owns acquisition: it enforces the declared size, decodes the file
 * and hands it over as `input.upload`. The plugin runs on the server (it may
 * need `ctx.query`/`ctx.read` to recognise earlier imports), and nothing is
 * written until the proposal is approved in {@link RunPluginDialog}. A plugin
 * that also declares a `destination` gets a Set up step first, which creates
 * that table and stores it as the plugin's config.
 */
export function FileImport({
  resource,
  drive,
  source,
  manifest,
}: {
  resource: Resource;
  drive: string;
  source: string | undefined;
  manifest: PluginManifest;
}): React.JSX.Element {
  const store = useStore();
  const fileId = useId();
  const accepts = manifest.accepts ?? [];
  const [config, setConfig] = useState<JSONObject>();
  const [missing, setMissing] = useState<string[]>([]);
  const [file, setFile] = useState<File>();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState<'setup' | 'preview'>();
  const [verdict, setVerdict] = useState<string>();
  const [imported, setImported] = useState(false);
  const [refresh, setRefresh] = useState(0);

  useEffect(() => {
    let active = true;
    void storedConfig(store, drive, resource.subject, manifest)
      .then(found => {
        if (!active) return;
        setConfig(found);
        setMissing(
          pluginConfigProblems(found, manifest.config).map(p => p.message),
        );
      })
      .catch(reason => {
        if (active) setError(String(reason));
      });

    return () => {
      active = false;
    };
  }, [store, drive, resource.subject, manifest, refresh]);

  const setUp = async () => {
    if (!manifest.destination) return;
    setBusy('setup');
    setError('');

    try {
      await provisionDestination(
        store,
        drive,
        resource.subject,
        manifest.destination,
        manifest.config?.key,
      );
      setRefresh(n => n + 1);
    } catch (reason) {
      setError(`Could not set up this importer: ${String(reason)}`);
    } finally {
      setBusy(undefined);
    }
  };

  const preview = async () => {
    if (!file || !source || !config) return;
    setBusy('preview');
    setError('');
    setImported(false);

    try {
      const max = maxBytes(accepts);
      if (file.size > max)
        throw new Error(
          `This file is ${formatBytes(file.size)}; this importer accepts at most ${formatBytes(max)}. Export a shorter period.`,
        );
      const text = decode(await file.arrayBuffer());
      const result = await executeServerPlugin(store, {
        drive,
        plugin: resource.subject,
        source,
        input: {
          upload: {
            name: file.name,
            mediaType: file.type,
            size: file.size,
            text,
          },
          config,
          trigger: {
            kind: 'manual',
            at: Date.now(),
            subject: resource.subject,
          },
        },
      });
      if (result.error || !result.verdict)
        throw new Error(result.error ?? 'The importer returned no preview.');
      setVerdict(result.verdict);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(undefined);
    }
  };

  const table = typeof config?.table === 'string' ? config.table : undefined;

  if (config === undefined && !error) return <p>Loading importer…</p>;

  return (
    <Column gap='0.75rem'>
      {missing.length > 0 ? (
        manifest.destination ? (
          <>
            <p>
              Set up creates a {manifest.destination.table.name} table for this
              importer. Nothing is imported yet.
            </p>
            <Button disabled={busy !== undefined} onClick={setUp}>
              {busy === 'setup' ? 'Setting up…' : 'Set up'}
            </Button>
          </>
        ) : (
          missing.map(message => <p key={message}>{message}</p>)
        )
      ) : (
        <>
          <Field fieldId={fileId} label='File to import'>
            <Input
              id={fileId}
              type='file'
              accept={acceptAttribute(accepts)}
              disabled={busy !== undefined}
              onChange={event => {
                setFile(event.target.files?.[0]);
                setError('');
                setImported(false);
              }}
            />
          </Field>
          <p>
            The file is read by this plugin on your AtomicServer, up to{' '}
            {formatBytes(maxBytes(accepts))}. Review the proposed changes before
            anything is saved.
          </p>
          <Button disabled={busy !== undefined || !file} onClick={preview}>
            {busy === 'preview' ? 'Preparing preview…' : 'Preview import'}
          </Button>
        </>
      )}
      {error && <ErrMessage role='alert'>{error}</ErrMessage>}
      {imported && table && (
        <AtomicLink subject={table}>Open imported data</AtomicLink>
      )}
      {verdict && (
        <RunPluginDialog
          resource={resource}
          drive={drive}
          show
          verdict={verdict}
          triggerKind='manual'
          onShowChange={open => {
            if (!open) setVerdict(undefined);
          }}
          onReviewed={() => {
            setImported(true);
            setVerdict(undefined);
          }}
        />
      )}
    </Column>
  );
}

function maxBytes(accepts: DeclaredAccept[]): number {
  return Math.max(
    0,
    ...accepts.map(accept => accept.maxBytes ?? DEFAULT_ACCEPT_MAX_BYTES),
  );
}

function acceptAttribute(accepts: DeclaredAccept[]): string | undefined {
  const values = accepts.flatMap(accept => [
    ...(accept.extensions ?? []),
    ...(accept.mediaTypes ?? []),
  ]);

  return values.length ? values.join(',') : undefined;
}

function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024)
    return `${Math.round((bytes / (1024 * 1024)) * 10) / 10} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;

  return `${bytes} bytes`;
}

/** UTF-8 when the file is valid UTF-8; older bank exports are often Windows-1252. */
export function decode(bytes: ArrayBuffer): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return new TextDecoder('windows-1252').decode(bytes);
  }
}

async function storedConfig(
  store: Store,
  drive: string,
  plugin: string,
  manifest: PluginManifest,
): Promise<JSONObject> {
  const terms = await pluginClassesFor(store, drive);
  const resource = await store.getResource(plugin);

  return pluginConfigFor(
    {
      schemas: resource.get(terms.properties['plugin-schemas']),
      connection: resource.get(terms.properties['plugin-connection']),
    },
    manifest.config,
  );
}

async function ensureChild(
  store: Store,
  drive: string,
  parent: string,
  localId: string,
  isA: string,
  propVals: Record<string, unknown>,
): Promise<Resource> {
  const existing = await store.findByLocalId(drive, parent, localId);
  const resource =
    existing ??
    (await store.newResource({
      parent,
      isA,
      propVals: { [core.properties.localId]: localId },
    }));

  for (const [property, value] of Object.entries(propVals))
    await resource.set(property, value as never);
  await resource.save();

  return resource;
}

/**
 * Creates what a `destination` declares and stores it as the plugin's config:
 * the schema in the drive's ontology, one table beneath the plugin with a
 * default table view, and `{ table, rowClass, properties }` under the
 * manifest's config key. Resumes the same resources when repeated, so a lost
 * response or a second click does not create a second table.
 */
export async function provisionDestination(
  store: Store,
  drive: string,
  plugin: string,
  destination: DeclaredDestination,
  key: string | undefined,
): Promise<JSONObject> {
  const terms = await ensureSchema(
    store,
    drive,
    destination.schema as SchemaSpec,
  );
  const rowClass = terms.classes[destination.table.rowClass];
  const table = await ensureChild(
    store,
    drive,
    plugin,
    'atomic:destination:table',
    dataBrowser.classes.table,
    {
      [core.properties.name]: destination.table.name,
      [core.properties.classtype]: rowClass,
    },
  );
  const view = await ensureChild(
    store,
    drive,
    table.subject,
    'atomic:destination:default-view',
    dataBrowser.classes.view,
    {
      [core.properties.name]: destination.table.name,
      [dataBrowser.properties.viewKind]: 'table',
      [dataBrowser.properties.viewColumns]: destination.table.columns.map(
        column => terms.properties[column],
      ),
    },
  );
  await table.set(dataBrowser.properties.tableViews, [view.subject]);
  await table.set(dataBrowser.properties.tableDefaultView, view.subject);
  await table.save();

  const config: JSONObject = {
    table: table.subject,
    rowClass,
    properties: terms.properties,
  };
  const pluginTerms = await pluginClassesFor(store, drive);
  const resource = await store.getResource(plugin);
  const stored = resource.get(pluginTerms.properties['plugin-schemas']);
  const current =
    stored && typeof stored === 'object' && !Array.isArray(stored)
      ? (stored as JSONObject)
      : {};
  await resource.set(
    pluginTerms.properties['plugin-schemas'],
    key ? { ...current, [key]: config } : { ...current, ...config },
  );
  await resource.set(pluginTerms.properties['plugin-workspace'], table.subject);
  await resource.save();

  return config;
}
