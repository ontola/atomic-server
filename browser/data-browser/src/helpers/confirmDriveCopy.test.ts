// @wc-ignore-file
import { afterEach, expect, it, vi } from 'vitest';
import type { Agent, Store } from '@tomic/lib';
import { confirmDriveCopy } from './confirmDriveCopy';

vi.mock('@tomic/lib', () => ({ signRequest: vi.fn(async () => ({})) }));
afterEach(() => vi.unstubAllGlobals());

const drive = 'atomic:confirmation-drive';
const hash = 'a'.repeat(64);

const fixture = () => {
  const db = {
    isReady: true,
    flush: vi.fn(async () => undefined),
    getVersionVectorsForDrive: vi.fn(),
  };
  const store = {
    getClientDb: () => db,
    normalizeSubject: (subject: string) => subject,
    computeDriveSyncState: async () => ({
      hashVersion: 2,
      driveHash: hash,
      vvs: {},
    }),
  } as unknown as Store;

  return () =>
    confirmDriveCopy(
      store,
      drive,
      'https://server.test',
      {} as Agent,
      new AbortController().signal,
      () => true,
    );
};

const proof = (confirmed = true, driveHash = hash) => ({
  version: 1,
  drive,
  hashVersion: 2,
  driveHash,
  confirmed,
  checkedBlobs: 0,
});

it('leaves an empty204 unconfirmed and accepts a later stable matching proof', async () => {
  const fetch = vi
    .fn()
    .mockResolvedValueOnce(new Response(null, { status: 204 }))
    .mockResolvedValueOnce(Response.json(proof()));
  vi.stubGlobal('fetch', fetch);
  const confirm = fixture();
  await expect(confirm()).resolves.toBeUndefined();
  await expect(confirm()).resolves.toBe(true);
  expect(fetch).toHaveBeenCalledTimes(2);
});

it('never parses or turns a deferred204 into a receipt', async () => {
  const json = vi.fn(async () => proof());
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({ ok: true, status: 204, json })),
  );
  await expect(fixture()()).resolves.toBeUndefined();
  expect(json).not.toHaveBeenCalled();
});

it('preserves negative proof and exact-hash validation', async () => {
  vi.stubGlobal(
    'fetch',
    vi
      .fn()
      .mockResolvedValueOnce(Response.json(proof(false)))
      .mockResolvedValueOnce(Response.json(proof(true, 'b'.repeat(64)))),
  );
  const confirm = fixture();
  await expect(confirm()).resolves.toBe(false);
  await expect(confirm()).resolves.toBeUndefined();
});
