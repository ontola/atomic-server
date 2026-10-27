import { describe, expect, it, vi } from 'vitest';
import type { Store, ApplyReport, PluginManifest, RunPlan } from '@tomic/react';
import {
  FOREIGN_IMPORTER,
  NO_IMPORTER,
  resolveAppImporter,
  importerRunSummary,
} from './appImporter';
import { handleRequest } from './hostStore';
vi.mock('@tomic/react', async () => ({
  ...(await vi.importActual<typeof import('@tomic/react')>('@tomic/react')),
  destinationOwnerOf: async (_store: unknown, _drive: string, table: string) =>
    table === 'did:ad:transactions' || table === 'did:ad:statements'
      ? IMPORTER
      : undefined,
  findSchema: async () => ({ properties: PLUGIN_TERMS }),
}));
const IMPORTER = 'did:ad:importer';
const PLUGIN_TERMS = {
  'plugin-source': 'did:ad:p:source',
  'plugin-schemas': 'did:ad:p:schemas',
  'plugin-connection': 'did:ad:p:connection',
};
const APP = 'did:ad:app',
  DRIVE = 'did:ad:drive';
const fakeStore = () => ({}) as Store;
const req = (op: string, args: object) => ({
  __atomic: true as const,
  id: 1,
  op,
  ...args,
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

  it('refuses binary data before previewing on this text-only host', async () => {
    await expect(
      resolve('did:ad:transactions', {
        file: { name: 'data.bin', base64: 'AA==' },
      } as never),
    ).rejects.toThrow('text imports only');
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
    const fetch = vi.spyOn(globalThis, 'fetch');
    await expect(
      handleRequest(
        fakeStore(),
        APP,
        DRIVE,
        req('runImporter', { file: { name: 'a.sta', text: 'x' } }),
        'did:ad:transactions',
      ),
    ).rejects.toThrow(/needs host confirmation and review/);
    expect(fetch).not.toHaveBeenCalled();
    fetch.mockRestore();
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
