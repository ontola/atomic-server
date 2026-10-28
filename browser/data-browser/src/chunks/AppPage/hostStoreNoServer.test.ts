// @wc-ignore-file
import { expect, it, vi } from 'vitest';
import { HostError } from '@tomic/plugin';
import type { NativeChannel } from '@tomic/react';
import { createEmbedStore } from '../../embed/embedStore';
import { handleRequest } from './hostStore';

vi.mock('@helpers/extensions/viewPolicy', async importOriginal => ({
  ...(await importOriginal<typeof import('@helpers/extensions/viewPolicy')>()),
  // The rights walk is tested elsewhere; here only where writes go.
  canViewAccess: async () => true,
}));

const AGENT = 'atomic:agent:pZyZYvKoOcwczHXJoYvYctgrHXn2pZ7qfeWMyoUfQ_8';
const APP = 'did:ad:app';
const DRIVE = 'did:ad:drive';
const ROW = 'atomic:row';

/** A host that keeps rows, signs nothing but commits, and records every call. */
function host() {
  const calls: Array<[string, unknown[]]> = [];
  const rows = new Map<string, Record<string, unknown>>();
  const name = 'https://atomicdata.dev/properties/name';
  const channel: NativeChannel = {
    async call(method, args) {
      calls.push([method, args]);

      switch (method) {
        case 'init':
          return true;
        case 'agent':
          return AGENT;
        case 'sign':
          throw new Error('only commits are signed');

        case 'appWrite': {
          const request = args[2] as {
            op: string;
            subject?: string;
            isA?: string[];
            propVals?: Record<string, unknown>;
            properties?: string[];
          };

          if (request.op === 'create') {
            rows.set(ROW, {
              '@id': ROW,
              'https://atomicdata.dev/properties/isA': request.isA,
              ...request.propVals,
            });

            return { subject: ROW };
          }

          const row = rows.get(request.subject!)!;

          if (request.op === 'save') Object.assign(row, request.propVals);

          if (request.op === 'remove')
            request.properties!.forEach(p => delete row[p]);

          return { subject: request.subject };
        }

        case 'getResourcesWithSnapshots':
          return (args[0] as string[]).map(s => ({
            jsonAd: rows.has(s) ? JSON.stringify(rows.get(s)) : null,
            snapshot: null,
          }));
        case 'getResource':
          return rows.has(args[0] as string)
            ? JSON.stringify(rows.get(args[0] as string))
            : null;
        case 'outboxEntries':
          return [];
        default:
          return null;
      }
    },
  };

  return { channel, calls, name };
}

async function setup() {
  const h = host();
  const { store } = await createEmbedStore(h.channel);

  return { ...h, store };
}

it('creates through the host as the app, signing nothing', async () => {
  const { store, calls, name } = await setup();

  const created = (await handleRequest(store, APP, DRIVE, {
    __atomic: true,
    id: 1,
    op: 'create',
    isA: ['did:ad:class'],
    propVals: { [name]: 'one' },
  })) as { subject: string };

  expect(created.subject).toBe(ROW);
  expect(calls.filter(([m]) => m === 'appWrite')).toEqual([
    [
      'appWrite',
      [
        DRIVE,
        APP,
        {
          op: 'create',
          parent: APP,
          isA: ['did:ad:class'],
          propVals: { [name]: 'one' },
        },
      ],
    ],
  ]);
  expect(calls.some(([m]) => m === 'sign')).toBe(false);
});

it('saves and removes through the host, and a read then sees the new value', async () => {
  const { store, calls, name } = await setup();
  const other = 'https://atomicdata.dev/properties/shortname';

  await handleRequest(store, APP, DRIVE, {
    __atomic: true,
    id: 1,
    op: 'create',
    isA: ['did:ad:class'],
    propVals: { [name]: 'one', [other]: 'keep' },
  });
  // Cached in this page before the write behind its back.
  expect(
    (await handleRequest(store, APP, DRIVE, {
      __atomic: true,
      id: 2,
      op: 'get',
      subject: ROW,
    })) as { propVals: Record<string, unknown> },
  ).toMatchObject({
    propVals: { [name]: 'one' },
  });

  await handleRequest(store, APP, DRIVE, {
    __atomic: true,
    id: 3,
    op: 'save',
    subject: ROW,
    remove: [other],
    propVals: { [name]: 'two' },
  });

  const writes = calls.filter(([m]) => m === 'appWrite').map(c => c[1][2]);

  expect(writes.slice(1)).toEqual([
    { op: 'remove', subject: ROW, properties: [other] },
    { op: 'save', subject: ROW, propVals: { [name]: 'two' } },
  ]);

  const read = (await handleRequest(store, APP, DRIVE, {
    __atomic: true,
    id: 4,
    op: 'get',
    subject: ROW,
  })) as { propVals: Record<string, unknown> };

  expect(read.propVals[name]).toBe('two');
  expect(read.propVals[other]).toBeUndefined();
});

it('refuses to call another app without a server', async () => {
  const { store } = await setup();
  const err = await handleRequest(store, APP, DRIVE, {
    __atomic: true,
    id: 1,
    op: 'call',
    interface: 'x:y/z',
    function: 'f',
  }).catch(e => e);

  expect(err).toBeInstanceOf(HostError);
  expect((err as HostError).code).toBe('unsupported');
});
