import { beforeEach, describe, expect, it, vi } from 'vitest';
import { core } from '@tomic/react';
import type { Store } from '@tomic/react';
import type { ApplyReport, PluginManifest, RunPlan } from '@tomic/react';
import {
  FOREIGN_IMPORTER,
  NO_IMPORTER,
  handleRequest,
  importerRunSummary,
  isHostRequest,
  isWithinApp,
  resolveAppImporter,
} from './hostStore';

vi.mock('@tomic/react', async () => {
  const actual =
    await vi.importActual<typeof import('@tomic/react')>('@tomic/react');

  // Signing needs a real key and a real agent; what these tests are about is
  // which requests leave and which are refused before they do.
  return {
    ...actual,
    signRequest: async () => ({}),
    // Reading an importer's stored config is tested in @tomic/lib
    // (plugin-destination.test.ts); here only what `data` passes on.
    destinationTablesFor: async (
      _store: unknown,
      _drive: string,
      table: string,
    ) => (table === 'did:ad:transactions' ? DESTINATION_TABLES : undefined),
    // Likewise: which plugin's Set up made a table is tested in @tomic/lib.
    destinationOwnerOf: async (
      _store: unknown,
      _drive: string,
      table: string,
    ) =>
      table === 'did:ad:transactions' || table === 'did:ad:statements'
        ? IMPORTER
        : undefined,
    findSchema: async () => ({ properties: PLUGIN_TERMS }),
  };
});

const IMPORTER = 'did:ad:importer';
const PLUGIN_TERMS = {
  'plugin-source': 'did:ad:p:source',
  'plugin-schemas': 'did:ad:p:schemas',
  'plugin-connection': 'did:ad:p:connection',
};

const DESTINATION_TABLES = {
  statements: { table: 'did:ad:statements', rowClass: 'did:ad:statement' },
  closingBalances: { table: 'did:ad:balances', rowClass: 'did:ad:balance' },
};

const APP = 'did:ad:app';
const DRIVE = 'did:ad:drive';

/** Every write the host asked the server to make on the app's behalf. */
let sent: Array<Record<string, unknown>>;

beforeEach(() => {
  sent = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: string, init: RequestInit) => {
      sent.push(JSON.parse(init.body as string));

      return {
        ok: true,
        json: async () => ({ subject: 'did:ad:written' }),
        text: async () => '',
      } as unknown as Response;
    }),
  );
});

/** A store with a parent chain, which is what the write rule is about. */
function fakeStore(parents: Record<string, string | undefined> = {}) {
  return {
    getAgent: () => ({ subject: 'did:ad:agent:me' }),
    getServerUrl: () => 'https://node.test',
    getResource: async (subject: string) => ({
      subject,
      error: undefined,
      get: (property: string) =>
        property === core.properties.parent ? parents[subject] : undefined,
      getPropVals: () => ({ [core.properties.parent]: parents[subject] }),
    }),
    search: async () => ['did:ad:found'],
  } as unknown as Store;
}

const req = (op: string, extra: Record<string, unknown> = {}) =>
  ({ __atomic: true as const, id: 1, op, ...extra }) as never;

describe('writing as the app', () => {
  it('asks the server to write, rather than signing as the person', async () => {
    const store = fakeStore({ 'did:ad:mine': APP });

    await handleRequest(
      store,
      APP,
      DRIVE,
      req('save', { subject: 'did:ad:mine', propVals: { p: 'v' } }),
    );

    // The point of the round trip: the server holds the app's key, so the
    // commit is authored by the app and bounded by the app's rights.
    expect(sent).toEqual([
      {
        drive: DRIVE,
        app: APP,
        op: 'save',
        subject: 'did:ad:mine',
        propVals: { p: 'v' },
      },
    ]);
  });

  it('creates under the app when given no parent', async () => {
    const store = fakeStore();

    await handleRequest(store, APP, DRIVE, req('create'));

    expect(sent[0]).toMatchObject({ op: 'create', parent: APP });
  });

  it('reaches data nested deeper inside itself', async () => {
    const store = fakeStore({
      'did:ad:deep': 'did:ad:mid',
      'did:ad:mid': APP,
    });

    await expect(isWithinApp(store, 'did:ad:deep', APP)).resolves.toBe(true);
  });

  it('refuses outside itself before anything leaves', async () => {
    const store = fakeStore({ 'did:ad:elsewhere': 'did:ad:drive' });

    await expect(
      handleRequest(
        store,
        APP,
        DRIVE,
        req('save', { subject: 'did:ad:elsewhere', propVals: { p: 'v' } }),
      ),
    ).rejects.toThrow(/only write its own data/);

    // Refused early so the app gets an error it can render, rather than a
    // round trip that the rights walk was always going to reject.
    expect(sent).toHaveLength(0);
  });

  it('refuses to destroy outside itself', async () => {
    const store = fakeStore({ 'did:ad:elsewhere': 'did:ad:drive' });

    await expect(
      handleRequest(
        store,
        APP,
        DRIVE,
        req('destroy', { subject: 'did:ad:elsewhere' }),
      ),
    ).rejects.toThrow(/only write its own data/);
    expect(sent).toHaveLength(0);
  });

  it('refuses to create outside itself', async () => {
    const store = fakeStore({ 'did:ad:elsewhere': 'did:ad:drive' });

    await expect(
      handleRequest(
        store,
        APP,
        DRIVE,
        req('create', { parent: 'did:ad:elsewhere' }),
      ),
    ).rejects.toThrow(/only write its own data/);
    expect(sent).toHaveLength(0);
  });

  it('does not loop forever on a parent cycle', async () => {
    const store = fakeStore({ a: 'b', b: 'a' });

    await expect(isWithinApp(store, 'a', APP)).resolves.toBe(false);
  });

  it('reads stay on this session and never leave', async () => {
    const store = fakeStore({ 'did:ad:elsewhere': 'did:ad:drive' });

    // An app sees what the person looking at it can see. A write persists and
    // is attributable; a read is already on their screen.
    await expect(
      handleRequest(
        store,
        APP,
        DRIVE,
        req('get', { subject: 'did:ad:elsewhere' }),
      ),
    ).resolves.toMatchObject({ subject: 'did:ad:elsewhere' });
    expect(sent).toHaveLength(0);
  });

  it('sees the table it is a view of, not its own', async () => {
    const store = fakeStore();

    // The same app is its own thing on its own page and a way of looking at
    // someone else's rows on a table tab. It should not have to know which.
    const viewing = (await handleRequest(
      store,
      APP,
      DRIVE,
      req('data'),
      'did:ad:someone-elses-table',
    )) as { table: string };

    expect(viewing.table).toBe('did:ad:someone-elses-table');
  });

  it('names the other tables of a multi-class destination by their keys', async () => {
    const store = fakeStore();

    await expect(
      handleRequest(store, APP, DRIVE, req('data'), 'did:ad:transactions'),
    ).resolves.toEqual({
      table: 'did:ad:transactions',
      rowClass: undefined,
      tables: DESTINATION_TABLES,
    });
    // A single-table destination, or any other table, answers as before.
    await expect(
      handleRequest(store, APP, DRIVE, req('data'), 'did:ad:other'),
    ).resolves.toEqual({ table: 'did:ad:other', rowClass: undefined });
  });

  it('refuses an operation it does not implement', async () => {
    const store = fakeStore();

    await expect(handleRequest(store, APP, DRIVE, req('sudo'))).rejects.toThrow(
      /does not do/,
    );
  });
});

describe('isHostRequest', () => {
  it('ignores messages that are not ours', () => {
    expect(isHostRequest({ type: '__atomic_plugin_ready' })).toBe(false);
    expect(isHostRequest(null)).toBe(false);
    expect(isHostRequest({ __atomic: true })).toBe(false);
    expect(isHostRequest({ __atomic: true, id: 1 })).toBe(true);
  });
});

describe('integration-proxy capabilities', () => {
  const minted = {
    capability: 'payload.sig',
    aud: 'https://proxy.example',
    exp: 1,
    connectionId: 'c1',
    platform: 'pets',
  };
  const proxy = {
    capability: vi.fn(async () => minted),
    connections: vi.fn(async () => [{ connectionId: 'c1', platform: 'pets' }]),
  };

  it('mints a capability for the frame key, never touching the server', async () => {
    const result = await handleRequest(
      fakeStore(),
      APP,
      DRIVE,
      req('proxyCapability', {
        platform: 'pets',
        connectionId: 'c1',
        publicKey: 'frame-key',
      }),
      undefined,
      proxy,
    );
    expect(result).toEqual(minted);
    expect(proxy.capability).toHaveBeenCalledWith({
      platform: 'pets',
      connectionId: 'c1',
      publicKey: 'frame-key',
    });
    expect(sent).toEqual([]);
  });

  it('lists connection references, and none without a proxy', async () => {
    expect(
      await handleRequest(
        fakeStore(),
        APP,
        DRIVE,
        req('proxyConnections', { platform: 'pets' }),
        undefined,
        proxy,
      ),
    ).toEqual([{ connectionId: 'c1', platform: 'pets' }]);
    expect(
      await handleRequest(
        fakeStore(),
        APP,
        DRIVE,
        req('proxyConnections', { platform: 'pets' }),
      ),
    ).toEqual([]);
  });

  it('refuses without a proxy, a connection or a frame key', async () => {
    await expect(
      handleRequest(
        fakeStore(),
        APP,
        DRIVE,
        req('proxyCapability', {
          platform: 'pets',
          connectionId: 'c1',
          publicKey: 'k',
        }),
      ),
    ).rejects.toThrow('cannot reach the integration proxy');
    await expect(
      handleRequest(
        fakeStore(),
        APP,
        DRIVE,
        req('proxyCapability', { platform: 'pets', publicKey: 'k' }),
        undefined,
        proxy,
      ),
    ).rejects.toThrow('connectionId is required');
    await expect(
      handleRequest(
        fakeStore(),
        APP,
        DRIVE,
        req('proxyCapability', { platform: 'pets', connectionId: 'c1' }),
        undefined,
        proxy,
      ),
    ).rejects.toThrow('publicKey is required');
  });

  it('no longer relays proxy calls through the page', async () => {
    await expect(
      handleRequest(
        fakeStore(),
        APP,
        DRIVE,
        req('proxy', { platform: 'pets', connectionId: 'c1', path: '/pets' }),
        undefined,
        proxy,
      ),
    ).rejects.toThrow();
  });
});

describe('running its own importer', () => {
  const MANIFEST: PluginManifest = {
    secrets: [],
    accepts: [{ extensions: ['.sta'], as: 'text', maxBytes: 10 }],
    config: { key: 'bank', required: ['table'] },
  } as unknown as PluginManifest;
  const describePlugin = async () => MANIFEST;

  /** The importer as Set up leaves it: its source, and its config under its key. */
  function importerStore(
    stored: Record<string, unknown> = { table: 'did:ad:transactions' },
  ) {
    const values: Record<string, Record<string, unknown>> = {
      [IMPORTER]: {
        [PLUGIN_TERMS['plugin-source']]: 'export function run() {}',
        [PLUGIN_TERMS['plugin-schemas']]: { bank: stored },
      },
    };

    return {
      getResource: async (subject: string) => ({
        subject,
        title: subject === IMPORTER ? 'Bank statements' : subject,
        get: (property: string) => values[subject]?.[property],
      }),
    } as unknown as Store;
  }

  const resolve = (
    table: string | undefined,
    request: Record<string, unknown> = {},
    store = importerStore(),
  ) => resolveAppImporter(store, DRIVE, table, request, describePlugin);

  it('finds the importer whose table the app shows, from any of its tables', async () => {
    for (const table of ['did:ad:transactions', 'did:ad:statements'])
      await expect(resolve(table)).resolves.toMatchObject({
        importer: IMPORTER,
        title: 'Bank statements',
        source: 'export function run() {}',
        config: { table: 'did:ad:transactions' },
      });
  });

  it('checks a file the app hands over, and passes it on as the upload', async () => {
    await expect(
      resolve('did:ad:transactions', {
        file: { name: 'a.sta', mediaType: 'text/plain', text: ':20:X' },
        importer: IMPORTER,
      }),
    ).resolves.toMatchObject({
      upload: {
        name: 'a.sta',
        mediaType: 'text/plain',
        size: 5,
        text: ':20:X',
      },
    });
    await expect(
      resolve('did:ad:transactions', {
        file: { name: 'big.sta', text: 'x'.repeat(11) },
      }),
    ).rejects.toThrow(/accepts at most 10 bytes/);
    await expect(
      resolve('did:ad:transactions', { file: { text: 'no name' } }),
    ).rejects.toThrow('file must be { name, mediaType?, text }');
  });

  it('has none on its own page or on a table no importer made', async () => {
    await expect(resolve(undefined)).rejects.toThrow(NO_IMPORTER);
    await expect(resolve('did:ad:someone-elses-table')).rejects.toThrow(
      NO_IMPORTER,
    );
  });

  it('refuses an importer of another package, even one the person can run', async () => {
    await expect(
      resolve('did:ad:transactions', { importer: 'did:ad:other-importer' }),
    ).rejects.toThrow(FOREIGN_IMPORTER);
  });

  it('refuses an importer that still needs Set up', async () => {
    await expect(
      resolve('did:ad:transactions', {}, importerStore({})),
    ).rejects.toThrow(/needs Set up/);
  });

  it('never runs or applies unseen, where the host cannot show the review', async () => {
    await expect(
      handleRequest(
        fakeStore(),
        APP,
        DRIVE,
        req('runImporter', { file: { name: 'a.sta', text: 'x' } }),
        'did:ad:transactions',
      ),
    ).rejects.toThrow(/cannot show an import review/);
    expect(sent).toHaveLength(0);
  });
});

describe('the summary the app gets back', () => {
  const plan = (over: Partial<RunPlan> = {}): RunPlan =>
    ({
      changes: [],
      problems: [],
      minted: {},
      blocked: false,
      ...over,
    }) as RunPlan;

  it('counts what was applied, by kind, and names what failed', () => {
    const report = {
      outcomes: [
        { op: 'create', planned: 'a', subject: 'r1', status: 'applied' },
        { op: 'create', planned: 'b', subject: 'r2', status: 'applied' },
        { op: 'set', planned: 'r3', subject: 'r3', status: 'applied' },
        { op: 'remove', planned: 'r3', subject: 'r3', status: 'applied' },
        { op: 'destroy', planned: 'r4', subject: 'r4', status: 'applied' },
        {
          op: 'create',
          planned: 'c',
          subject: 'c',
          status: 'failed',
          error: 'refused',
        },
      ],
      applied: 5,
      skipped: 0,
      failed: 1,
      subjects: {},
      stoppedEarly: false,
    } as ApplyReport;

    expect(importerRunSummary(IMPORTER, { report, plan: plan() })).toEqual({
      status: 'applied',
      importer: IMPORTER,
      created: 2,
      updated: 1,
      destroyed: 1,
      failed: 1,
      errors: ['refused'],
    });
  });

  it('tells a closed review apart from a refused file and from nothing new', () => {
    expect(importerRunSummary(IMPORTER, {})).toEqual({
      status: 'cancelled',
      importer: IMPORTER,
    });
    expect(
      importerRunSummary(IMPORTER, {
        plan: plan({ changes: [{ op: 'create' }] as RunPlan['changes'] }),
      }),
    ).toEqual({ status: 'cancelled', importer: IMPORTER });
    expect(importerRunSummary(IMPORTER, { plan: plan() })).toEqual({
      status: 'nothing',
      importer: IMPORTER,
    });
    expect(
      importerRunSummary(IMPORTER, {
        plan: plan({
          blocked: true,
          problems: [
            { severity: 'error', message: 'does not reconcile' },
            { severity: 'warning', message: 'just so you know' },
          ],
        }),
      }),
    ).toEqual({
      status: 'blocked',
      importer: IMPORTER,
      errors: ['does not reconcile'],
    });
    expect(
      importerRunSummary(IMPORTER, { error: 'Not a bank statement' }),
    ).toEqual({
      status: 'blocked',
      importer: IMPORTER,
      errors: ['Not a bank statement'],
    });
  });
});
