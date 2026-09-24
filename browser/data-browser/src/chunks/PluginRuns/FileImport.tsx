import { useEffect, useId, useState } from 'react';
import {
  provisionDestination,
  pluginConfigFor,
  pluginConfigProblems,
  useStore,
  type DeclaredDestination,
  type JSONObject,
  type PluginManifest,
  type Resource,
  type Store,
} from '@tomic/react';
import { Button } from '@components/Button';
import { Column } from '@components/Row';
import Field from '@components/forms/Field';
import { Input, ErrMessage } from '@components/forms/InputStyles';
import { AtomicLink } from '@components/AtomicLink';
import { pluginClassesFor } from './runScript';
import { RunPluginDialog } from './RunPluginDialog';
import {
  acceptAttribute,
  formatBytes,
  maxBytes,
  previewImport,
  readUpload,
} from './importFile';

/**
 * The generic entry point for a plugin that declares `accepts`: choose a file,
 * preview what the plugin proposes for it, approve.
 *
 * The host owns acquisition: it enforces the declared size on the file's
 * bytes, reads the file as its `accepts` entry declares (decoded text, or
 * base64 of the exact bytes) and hands it over as `input.upload`. The plugin
 * runs on the server (it may need `ctx.query`/`ctx.read` to recognise earlier
 * imports), and nothing is
 * written until the proposal is approved in {@link RunPluginDialog}. A plugin
 * that also declares a `destination` gets a Set up step first, which creates
 * its tables and stores them as the plugin's config.
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
      setVerdict(
        await previewImport(store, {
          drive,
          plugin: resource.subject,
          source,
          config,
          upload: await readUpload(file, accepts),
        }),
      );
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(undefined);
    }
  };

  const table = firstTable(config);

  if (config === undefined && !error) return <p>Loading importer…</p>;

  return (
    <Column gap='0.75rem'>
      {missing.length > 0 ? (
        manifest.destination ? (
          <>
            <SetupSummary destination={manifest.destination} />
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

/** What Set up is about to create, named the way the sidebar will show it. */
function SetupSummary({
  destination,
}: {
  destination: DeclaredDestination;
}): React.JSX.Element {
  const names = [
    ...(destination.table ? [destination.table.name] : []),
    ...Object.values(destination.tables ?? {}).map(table => table.name),
  ];

  if (names.length === 1)
    return (
      <p>
        Set up creates a {names[0]} table for this importer. Nothing is imported
        yet.
      </p>
    );

  return (
    <>
      <p>
        Set up creates {names.length} tables for this importer. Nothing is
        imported yet.
      </p>
      <ul>
        {names.map(name => (
          <li key={name}>{name}</li>
        ))}
      </ul>
    </>
  );
}

/** Where "Open imported data" goes: the table a single-table importer writes, or its first. */
function firstTable(config: JSONObject | undefined): string | undefined {
  if (typeof config?.table === 'string') return config.table;
  const tables = config?.tables;
  if (!tables || typeof tables !== 'object' || Array.isArray(tables))
    return undefined;
  const first = Object.values(tables)[0];

  return first &&
    typeof first === 'object' &&
    !Array.isArray(first) &&
    typeof first.table === 'string'
    ? first.table
    : undefined;
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
