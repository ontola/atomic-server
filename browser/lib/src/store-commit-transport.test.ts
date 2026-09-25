import { afterEach, describe, expect, it, vi } from 'vitest';
import { Store } from './store.js';
import { AtomicError, ErrorType, isTransportError } from './error.js';
import type { Commit } from './commit.js';
import { ErrorCode } from './ws-v2.js';

afterEach(() => vi.unstubAllGlobals());

type Socket = { readyState: number; postCommit: ReturnType<typeof vi.fn> };

function storeWithSocket(socket: Socket | undefined) {
  const store = new Store({ serverUrl: 'https://example.com' });
  vi.stubGlobal('WebSocket', { OPEN: 1 });
  const internals = store as unknown as {
    getWebSocketForEndpoint: () => unknown;
  };
  vi.spyOn(internals, 'getWebSocketForEndpoint').mockReturnValue(socket);
  vi.spyOn(store, 'getDefaultWebSocket').mockReturnValue(undefined);
  const fetch = vi.fn();
  store.injectFetch(fetch);

  return { store, fetch };
}

const commit = { subject: 'did:ad:edit' } as Commit;
const endpoint = 'https://example.com/commit';

describe('commit transport', () => {
  it('sends commits over the open socket', async () => {
    const socket = { readyState: 1, postCommit: vi.fn() };
    socket.postCommit.mockResolvedValue(commit);
    const { store, fetch } = storeWithSocket(socket);

    await expect(store.postCommit(commit, endpoint)).resolves.toBe(commit);
    expect(socket.postCommit).toHaveBeenCalledTimes(1);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('fails with a transport error when no socket is open, without HTTP', async () => {
    const { store, fetch } = storeWithSocket({
      readyState: 3,
      postCommit: vi.fn(),
    });

    const error = await store.postCommit(commit, endpoint).catch(e => e);
    expect(isTransportError(error)).toBe(true);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('reports a socket that drops mid-commit as a transport error', async () => {
    const socket = { readyState: 1, postCommit: vi.fn() };
    socket.postCommit.mockImplementation(async () => {
      socket.readyState = 3;
      throw new AtomicError(
        'WebSocket closed before response arrived',
        ErrorType.Server,
      );
    });
    const { store, fetch } = storeWithSocket(socket);

    const error = await store.postCommit(commit, endpoint).catch(e => e);
    expect(isTransportError(error)).toBe(true);
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([undefined, ErrorCode.SYNC_REJECTED])(
    'passes a server refusal through unchanged (code %s)',
    async code => {
      const rejected = new AtomicError(
        'Drive did:ad:private is not enrolled for sync on this node.',
        ErrorType.Server,
        code,
      );
      const socket = { readyState: 1, postCommit: vi.fn() };
      socket.postCommit.mockRejectedValue(rejected);
      const { store, fetch } = storeWithSocket(socket);

      await expect(store.postCommit(commit, endpoint)).rejects.toBe(rejected);
      expect(fetch).not.toHaveBeenCalled();
    },
  );
});
