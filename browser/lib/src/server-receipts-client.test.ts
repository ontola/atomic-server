import { afterEach, describe, expect, it, vi } from 'vitest';
import { Client } from './client.js';
import type { Agent } from './agent.js';
import type { Commit } from './commit.js';
import { LoroLoader } from './loro-loader.js';
import { encodeB64 } from './base64.js';
import {
  SERVER_RECEIPT_HEADER,
  SERVER_RECEIPT_CAPABILITY,
} from './server-receipts.js';
import { PEER_STORAGE_BARRIER } from './ws-v2.js';

const sign = vi.hoisted(() =>
  vi.fn(async (_url: string, _agent: unknown, headers: object) => headers),
);
vi.mock('./authentication.js', async original => ({
  ...(await original<typeof import('./authentication.js')>()),
  signRequest: sign,
}));
const endpoint = 'https://server.test/storage-receipt';
const commit = {
  subject: 'atomic:doc',
  signer: 'atomic:agent:a',
  createdAt: 1,
  signature: 'sig',
  loroUpdate: 'AAAA',
} as unknown as Commit;
const committed = JSON.stringify({
  '@id': 'atomic:commit:sig',
  'https://atomicdata.dev/properties/subject': 'atomic:doc',
  'https://atomicdata.dev/properties/signer': 'atomic:agent:a',
  'https://atomicdata.dev/properties/createdAt': 1,
  'https://atomicdata.dev/properties/signature': 'sig',
});
const request = () => ({
  nonce: 'a'.repeat(64),
  drive: 'atomic:drive',
  subject: 'atomic:doc',
  version: encodeB64(
    new LoroLoader.Loro.VersionVector(new Map([['1', 1]])).encode(),
  ),
});
const proof = () =>
  JSON.stringify({
    ...request(),
    replica: { storageId: 'b'.repeat(64), generation: 'c'.repeat(64) },
    barrier: PEER_STORAGE_BARRIER,
  });
const agent = { subject: 'atomic:agent:a' } as Agent;
const accepted = () =>
  new Response(committed, {
    headers: { [SERVER_RECEIPT_HEADER]: SERVER_RECEIPT_CAPABILITY },
  });
afterEach(() => {
  sign.mockClear();
  vi.restoreAllMocks();
});

describe('server receipt HTTP adapter', () => {
  it('keeps capability discovery optional for accepted relative endpoints and legacy servers', async () => {
    const fetcher = vi.fn(async () => accepted());
    const client = new Client(fetcher as typeof fetch);
    await expect(client.postCommit(commit, '/commit')).resolves.toBeDefined();
    fetcher.mockImplementation(async () => new Response(committed));
    await client.postCommit(commit, 'https://server.test/commit');
    expect(client.supportsStorageReceipts(endpoint)).toBe(false);
    expect(
      await client.requestStorageReceipt(
        endpoint,
        request(),
        agent,
        new AbortController().signal,
        () => true,
      ),
    ).toBeUndefined();
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('does not learn capabilities through a redirected commit response', async () => {
    const response = accepted();
    Object.defineProperty(response, 'redirected', { value: true });
    const client = new Client(vi.fn(async () => response) as typeof fetch);
    await client.postCommit(commit, 'https://server.test/commit');
    expect(client.supportsStorageReceipts(endpoint)).toBe(false);
  });

  it('uses body-bound authentication and refuses redirected receipt provenance', async () => {
    const response = new Response(proof());
    Object.defineProperty(response, 'url', {
      value: 'https://other.test/storage-receipt',
    });
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(accepted())
      .mockResolvedValueOnce(response);
    const client = new Client(fetcher);
    await client.postCommit(commit, 'https://server.test/commit');
    expect(
      await client.requestStorageReceipt(
        endpoint,
        request(),
        agent,
        new AbortController().signal,
        () => true,
      ),
    ).toBeUndefined();
    expect(sign).toHaveBeenCalledWith(
      endpoint,
      agent,
      { 'Content-Type': 'application/json' },
      { method: 'POST', body: JSON.stringify(request()) },
    );
    expect(fetcher.mock.calls[1][1]?.redirect).toBe('error');
  });

  it('caps the actual response stream before decoding a receipt', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(accepted())
      .mockResolvedValueOnce(new Response('x'.repeat(64 * 1024)));
    const client = new Client(fetcher);
    await client.postCommit(commit, 'https://server.test/commit');
    expect(
      await client.requestStorageReceipt(
        endpoint,
        request(),
        agent,
        new AbortController().signal,
        () => true,
      ),
    ).toBeUndefined();
  });

  it('does not send when identity changes while signing', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(accepted());
    const client = new Client(fetcher);
    await client.postCommit(commit, 'https://server.test/commit');
    let release!: () => void;
    sign.mockImplementationOnce(
      (_url, _agent, headers) =>
        new Promise(resolve => {
          release = () => resolve(headers);
        }),
    );
    let current = true;
    const pending = client.requestStorageReceipt(
      endpoint,
      request(),
      agent,
      new AbortController().signal,
      () => current,
    );
    current = false;
    release();
    expect(await pending).toBeUndefined();
    expect(fetcher).toHaveBeenCalledOnce();
  });
});
