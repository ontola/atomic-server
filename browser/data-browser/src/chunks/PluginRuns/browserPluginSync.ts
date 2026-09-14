// @wc-ignore-file
import type { Store, ExternalIntent, ExternalReceipt } from '@tomic/lib';
import { runWithAsyncReads } from '../../../../../integrations/localthought/async-plugin';
import {
  continueBrowserSync,
  type SyncSession,
  type Step,
} from '../../../../../integrations/localthought/browser-sync';
import { prepareFromVerdict, applyRun } from './runScript';

export interface BrowserPlugin {
  drive: string;
  plugin: string;
  config: unknown;
  source: string;
  /** Shipped code only, not editable resource source. */
  run(input: BrowserPluginInput): unknown;
  read(intent: ExternalIntent): Promise<ExternalReceipt>;
  write(intent: ExternalIntent): Promise<ExternalReceipt>;
}

export interface BrowserPluginInput {
  config: unknown;
  read(subject: string): Record<string, unknown>;
  query(property: string, value: string): string[];
  http(intent: ExternalIntent): ExternalReceipt;
}

async function binding(plugin: BrowserPlugin) {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(JSON.stringify([plugin.source, plugin.config])),
  );

  return Array.from(new Uint8Array(digest), byte =>
    byte.toString(16).padStart(2, '0'),
  ).join('');
}

function key(store: Store, plugin: BrowserPlugin) {
  const actor = store.getAgent()?.subject;
  if (!actor) throw new Error('Sign in before syncing');

  return `browser-plugin-sync-v1:${JSON.stringify([actor, plugin.drive, plugin.plugin])}`;
}

export function savedBrowserSync(
  store: Store,
  plugin: BrowserPlugin,
): SyncSession | undefined {
  const raw = localStorage.getItem(key(store, plugin));

  return raw ? JSON.parse(raw) : undefined;
}

async function invoke(store: Store, plugin: BrowserPlugin, input: object) {
  const rows = new Map<string, Record<string, unknown>>();
  let offset = 0;

  for (;;) {
    const result = await store.queryLocalDb({
      drive: plugin.drive,
      offset,
      limit: 1000,
    });
    if (!result)
      throw new Error('Local database must be available before syncing');
    for (const subject of result.subjects)
      rows.set(subject, (await store.getLocalResource(subject)).getPropVals());
    offset += result.subjects.length;
    if (offset >= result.count) break;
    if (!result.subjects.length || offset > 50000)
      throw new Error('Local sync snapshot is incomplete or too large');
  }

  return runWithAsyncReads(
    plugin.run,
    {
      ...input,
      config: plugin.config,
      read: (subject: string) => {
        const row = rows.get(subject);
        if (!row) throw new Error('Local sync resource is missing');

        return structuredClone(row);
      },
      query: (property: string, value: string) =>
        [...rows]
          .filter(([, row]) => row[property] === value)
          .map(([subject]) => subject),
    },
    plugin.read,
  );
}

export async function previewBrowserPlugin(
  store: Store,
  plugin: BrowserPlugin,
) {
  if (!navigator.locks)
    throw new Error('This browser needs Web Locks for sync');

  return navigator.locks.request(key(store, plugin), async () => {
    const previous = savedBrowserSync(store, plugin);
    if (previous && !previous.complete)
      throw new Error('Continue the saved sync before making a new preview');
    const connection = previous?.connection ?? {
      revision: 0,
      records: {},
      cursor: null,
    };
    const preview = (await invoke(store, plugin, {
      phase: 'preview',
      connection,
    })) as {
      kind: string;
      proposal: unknown;
      problems: { severity: string; message: string }[];
    };
    if (preview.kind !== 'preview')
      throw new Error('Plugin did not return a preview');
    if (preview.problems.some(p => p.severity === 'error'))
      throw new Error(preview.problems.map(p => p.message).join('\n'));

    return {
      proposal: preview.proposal,
      connection,
      binding: await binding(plugin),
    } satisfies SyncSession;
  });
}
export async function applyBrowserPlugin(
  store: Store,
  plugin: BrowserPlugin,
  approved: SyncSession,
) {
  if (!navigator.locks)
    throw new Error('This browser needs Web Locks for sync');

  return navigator.locks.request(key(store, plugin), async () => {
    if (approved.binding !== (await binding(plugin)))
      throw new Error(
        'Plugin code or mapping changed after preview; reconcile the saved run before continuing',
      );
    const save = (session: SyncSession) =>
      localStorage.setItem(key(store, plugin), JSON.stringify(session));
    const current = savedBrowserSync(store, plugin);
    if (
      current &&
      !current.complete &&
      JSON.stringify(current) !== JSON.stringify(approved)
    )
      throw new Error('Saved sync changed; reload before continuing');
    if (
      current?.complete &&
      current.connection.revision !== approved.connection.revision
    )
      throw new Error('Sync changed after preview; make a new preview');
    save(approved);

    return continueBrowserSync(approved, {
      save,
      step: session =>
        invoke(store, plugin, { ...session, phase: 'step' }) as Promise<Step>,
      external: plugin.write,
      atomic: async verdict => {
        const prepared = await prepareFromVerdict(
          store,
          JSON.stringify(verdict),
          { kind: 'manual', at: Date.now() },
        );
        const { report } = await applyRun(store, prepared, plugin);
        if (report.failed || report.stoppedEarly)
          throw new Error('Local sync did not complete; inspect the saved run');

        return report;
      },
    });
  });
}
