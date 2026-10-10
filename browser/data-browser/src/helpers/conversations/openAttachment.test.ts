import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Store } from '@tomic/react';
import type { SealedAttachment } from './attachments';

const openFile = vi.fn(
  async (_conversation: string, _key: string, bytes: Uint8Array) =>
    bytes.slice(1),
);

vi.mock('./conversationCrypto', () => ({
  openFile: (conversation: string, key: string, bytes: Uint8Array) =>
    openFile(conversation, key, bytes),
}));

const { loadAttachment } = await import('./openAttachment');

const HASH = 'cd'.repeat(32);
const attachment: SealedAttachment = {
  blob: `atomic:blob:${HASH}`,
  key: 'K'.repeat(43),
  name: 'a.txt',
  type: 'text/plain',
  size: 3,
};

function storeWith(getBlob?: () => Promise<Uint8Array | null>) {
  const putBlob = vi.fn(async () => undefined);
  const store = {
    getServerUrl: () => 'https://node.example',
    getClientDb: () => (getBlob ? { getBlob, putBlob } : undefined),
  } as unknown as Store;

  return { store, putBlob };
}

describe('loadAttachment', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    openFile.mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('uses the local copy and never asks the server', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const { store } = storeWith(async () => new Uint8Array([9, 1, 2]));

    const bytes = await loadAttachment(store, 'did:ad:room', attachment);

    expect(Array.from(bytes)).toEqual([1, 2]);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(openFile).toHaveBeenCalledWith(
      'did:ad:room',
      attachment.key,
      expect.any(Uint8Array),
    );
  });

  it('waits for an upload that is still on its way, then decrypts', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response('', { status: 404 }))
      .mockResolvedValueOnce(
        new Response(new Uint8Array([9, 7]), { status: 200 }),
      );
    vi.stubGlobal('fetch', fetchMock);
    const { store, putBlob } = storeWith(async () => null);

    const pending = loadAttachment(store, 'did:ad:room', attachment);
    await vi.advanceTimersByTimeAsync(5000);
    const bytes = await pending;

    expect(Array.from(bytes)).toEqual([7]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0][0]).toBe(
      `https://node.example/download/files/${HASH}`,
    );
    // The ciphertext is kept for next time, the plaintext is not.
    expect(putBlob).toHaveBeenCalledTimes(1);
  });

  it('gives up when the file never arrives', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('', { status: 404 })),
    );
    const { store } = storeWith(async () => null);

    const pending = loadAttachment(store, 'did:ad:room', attachment);
    const outcome = expect(pending).rejects.toThrow(/could not be fetched/);
    await vi.advanceTimersByTimeAsync(30_000);
    await outcome;
    expect(openFile).not.toHaveBeenCalled();
  });

  it('refuses a reference that is not a blob', async () => {
    const { store } = storeWith();

    await expect(
      loadAttachment(store, 'did:ad:room', {
        ...attachment,
        blob: 'https://example.com/x',
      }),
    ).rejects.toThrow(/no valid reference/);
  });
});
