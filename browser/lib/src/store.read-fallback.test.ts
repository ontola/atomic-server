import { afterEach, describe, expect, it, vi } from 'vitest';
import { Store } from './store.js';
import { Resource } from './resource.js';
import { Agent } from './agent.js';
import { AtomicError, ErrorType } from './error.js';

const SUBJECT = 'atomic:invented-note';
const NAME = 'https://atomicdata.dev/properties/name';

async function fixture() {
  const agent = await Agent.generateNonExtractable();
  const store = new Store({
    serverUrl: 'http://localhost:19883',
    agent,
    connect: false,
  });
  const answer = new Resource(SUBJECT);
  await answer.set(NAME, 'Invented note', false);
  const http = vi
    .spyOn(
      (
        store as unknown as {
          client: {
            fetchResourceHTTP: (...args: unknown[]) => Promise<unknown>;
          };
        }
      ).client,
      'fetchResourceHTTP',
    )
    .mockResolvedValue({
      resource: answer,
      createdResources: [],
      cancelled: false,
    });
  const socket = {
    readyState: WebSocket.OPEN,
    fetch: vi.fn(
      (_subject: string, opts?: { signal?: AbortSignal }) =>
        new Promise<Resource>((_resolve, reject) => {
          opts?.signal?.addEventListener(
            'abort',
            () => reject(opts.signal!.reason),
            { once: true },
          );
        }),
    ),
  };
  vi.spyOn(store, 'getWebSocketForSubject').mockReturnValue(socket as never);

  return { store, agent, answer, http, socket };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('bounded WebSocket reads', () => {
  it('lets an adapter tune the WebSocket deadline', async () => {
    const { store, http } = await fixture();
    vi.spyOn(store, 'webSocketReadDeadlineMs').mockReturnValue(75);
    vi.useFakeTimers();
    const read = store.fetchResourceFromServer(SUBJECT);
    await vi.advanceTimersByTimeAsync(74);
    expect(http).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(http).toHaveBeenCalledOnce();
    await read;
  });

  it('uses the authenticated HTTP path when an OPEN local socket stops answering', async () => {
    const { store, agent, http } = await fixture();
    vi.useFakeTimers();
    const read = store.fetchResourceFromServer(SUBJECT);
    await vi.advanceTimersByTimeAsync(50);
    expect(http).toHaveBeenCalledTimes(1);
    expect(http).toHaveBeenCalledWith(
      SUBJECT,
      expect.objectContaining({
        signInfo: { agent, serverURL: store.getServerUrl() },
      }),
    );
    expect((await read).get(NAME)).toBe('Invented note');
  });

  it.each([
    ['http://localhost:19883', 'https://remote.example/note', 1000],
    ['https://remote.example', 'http://localhost:19883/note', 50],
  ])(
    'uses the requested authority for the read deadline (%s, %s)',
    async (server, subject, delay) => {
      const { store, http } = await fixture();
      store.setServerUrl(server, { connect: false });
      vi.useFakeTimers();
      const read = store.fetchResourceFromServer(subject);
      await vi.advanceTimersByTimeAsync(delay - 1);
      expect(http).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(http).toHaveBeenCalledOnce();
      await read;
    },
  );

  it('shares one HTTP fallback between concurrent readers', async () => {
    const { store, http } = await fixture();
    vi.useFakeTimers();
    const first = store.fetchResourceFromServer(SUBJECT);
    const second = store.fetchResourceFromServer(SUBJECT);
    await vi.advanceTimersByTimeAsync(50);
    expect(await first).toBe(await second);
    expect(http).toHaveBeenCalledOnce();
  });

  it('settles the loading resource if the fallback is refused', async () => {
    const { store, http } = await fixture();
    const refused = new Resource(SUBJECT);
    refused.loading = false;
    refused.error = new AtomicError('Unauthorized', ErrorType.Unauthorized);
    http.mockResolvedValue({
      resource: refused,
      createdResources: [],
      cancelled: false,
    });
    vi.useFakeTimers();
    const read = store.fetchResourceFromServer(SUBJECT);
    await vi.advanceTimersByTimeAsync(50);
    const result = await read;
    expect(result.loading).toBe(false);
    expect(result.error?.type).toBe(ErrorType.Unauthorized);
  });

  it('does not duplicate a healthy read over HTTP', async () => {
    const { store, answer, socket, http } = await fixture();
    socket.fetch.mockImplementation(async () => {
      store.addResource(answer);

      return answer;
    });
    vi.useFakeTimers();
    expect((await store.fetchResourceFromServer(SUBJECT)).get(NAME)).toBe(
      'Invented note',
    );
    await vi.advanceTimersByTimeAsync(1000);
    expect(http).not.toHaveBeenCalled();
  });

  it('preserves an explicit authorization refusal without retrying it', async () => {
    const { store, socket, http } = await fixture();
    const refused = new AtomicError('Unauthorized', ErrorType.Unauthorized);
    socket.fetch.mockRejectedValue(refused);
    await expect(store.fetchResourceFromServer(SUBJECT)).rejects.toBe(refused);
    expect(http).not.toHaveBeenCalled();
  });

  it('sends POST requests once through HTTP', async () => {
    const { store, http, socket } = await fixture();
    await store.fetchResourceFromServer(SUBJECT, {
      method: 'POST',
      body: 'invented query',
    });
    expect(socket.fetch).not.toHaveBeenCalled();
    expect(http).toHaveBeenCalledOnce();
  });
});
