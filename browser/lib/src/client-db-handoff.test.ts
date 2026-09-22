import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ClientDbWorker } from './client-db.js';

type Message = Record<string, unknown>;
const clients: ClientDbWorker[] = [];
const workers: TestWorker[] = [];
const channels = new Set<TestChannel>();
const blobs = new Map<string, Uint8Array>();
let heldNewWorkers: string | undefined;

class TestChannel {
  onmessage?: (event: { data: Message }) => void;
  constructor(readonly name: string) {
    channels.add(this);
  }
  postMessage(data: Message) {
    for (const channel of channels) {
      if (channel === this || channel.name !== this.name) continue;
      queueMicrotask(() => {
        if (channels.has(channel))
          channel.onmessage?.({ data: structuredClone(data) });
      });
    }
  }
  close() {
    channels.delete(this);
  }
}

class TestWorker {
  onmessage?: (event: { data: Message }) => void;
  heldType?: string;
  messages: Message[] = [];
  terminated = false;
  constructor() {
    this.heldType = heldNewWorkers;
    workers.push(this);
  }
  postMessage(message: Message) {
    this.messages.push(message);

    // A lost acknowledgement can follow a completed content-addressed write.
    if (message.type === 'putBlob') {
      blobs.set(String(message.hash), message.data as Uint8Array);
    }

    if (message.type === this.heldType) return;
    setTimeout(
      () => {
        if (this.terminated) return;
        const data =
          message.type === 'blake3Hash'
            ? new Uint8Array([1, 2, 3])
            : message.type === 'getBlob'
              ? blobs.get(String(message.hash))
              : undefined;
        this.onmessage?.({ data: { id: message.id, type: 'result', data } });
      },
      message.type === 'init' ? 25 : 1,
    );
  }
  terminate() {
    this.terminated = true;
  }
}

beforeEach(() => {
  vi.useFakeTimers();
  heldNewWorkers = undefined;
  let tail = Promise.resolve();
  vi.stubGlobal('navigator', {
    locks: {
      request: (
        _name: string,
        options: LockOptions,
        callback: () => Promise<void>,
      ) => {
        const request = tail.then(() => {
          if (options.signal?.aborted)
            throw new DOMException('Aborted', 'AbortError');

          return callback();
        });
        tail = request.catch(() => {});

        return request;
      },
    },
  });
  vi.stubGlobal('BroadcastChannel', TestChannel);
  vi.stubGlobal('Worker', TestWorker);
});

afterEach(async () => {
  for (const client of clients) client.destroy();
  await vi.advanceTimersByTimeAsync(0);
  clients.length = 0;
  workers.length = 0;
  channels.clear();
  blobs.clear();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

async function openTab() {
  const client = new ClientDbWorker('wasm-url', 'worker-url');
  clients.push(client);
  const init = client.init('https://example.com');
  await vi.advanceTimersByTimeAsync(100);
  await init;

  return client;
}

for (const replacement of ['uploading tab', 'another tab']) {
  for (const operation of ['blake3Hash', 'putBlob']) {
    it(`finishes an upload interrupted during ${operation} when ${replacement} takes leadership`, async () => {
      const leader = await openTab();
      if (replacement === 'another tab') await openTab();
      const uploader = await openTab();
      workers[0].heldType = operation;
      const bytes = new Uint8Array([10, 20, 30]);
      let result: Uint8Array | null | undefined;
      let error: unknown;
      const upload = (async () => {
        const hash = await uploader.blake3Hash(bytes);
        await uploader.putBlob(hash, bytes);

        return uploader.getBlob(hash);
      })();
      void upload.then(
        value => {
          result = value;
        },
        value => {
          error = value;
        },
      );
      await vi.advanceTimersByTimeAsync(10);
      expect(
        workers[0].messages.some(message => message.type === operation),
      ).toBe(true);
      leader.destroy();
      await vi.advanceTimersByTimeAsync(100);
      expect(error).toBeUndefined();
      expect(result).toEqual(bytes);
      expect(blobs.size).toBe(1);
    });
  }
}

it('does not duplicate a write when the same leader announces itself again', async () => {
  await openTab();
  const uploader = await openTab();
  workers[0].heldType = 'putBlob';
  void uploader
    .putBlob(new Uint8Array([1]), new Uint8Array([10]))
    .catch(() => {});
  await vi.advanceTimersByTimeAsync(10);
  await openTab(); // Its ping makes the existing leader announce again.
  expect(
    workers[0].messages.filter(message => message.type === 'putBlob'),
  ).toHaveLength(1);
});

it('does not replay a worker-local session mutation after a leader change', async () => {
  const leader = await openTab();
  const follower = await openTab();
  workers[0].heldType = 'createPeerSession';
  let error: unknown;
  void follower
    .createPeerSession('did:ad:drive', undefined, 'challenge')
    .catch(value => {
      error = value;
    });
  await vi.advanceTimersByTimeAsync(10);
  leader.destroy();
  await vi.advanceTimersByTimeAsync(100);
  expect(error).toEqual(
    expect.objectContaining({
      message: expect.stringContaining('leader changed'),
    }),
  );
  expect(
    workers[1].messages.some(message => message.type === 'createPeerSession'),
  ).toBe(false);
});

it('keeps a bounded timeout when the leader never changes', async () => {
  await openTab();
  const follower = await openTab();
  workers[0].heldType = 'blake3Hash';
  let error: unknown;
  void follower.blake3Hash(new Uint8Array([10])).catch(value => {
    error = value;
  });
  await vi.advanceTimersByTimeAsync(30_001);
  expect(error).toEqual(
    expect.objectContaining({
      message: expect.stringContaining('timed out after 30s'),
    }),
  );
  expect(
    workers[0].messages.filter(message => message.type === 'blake3Hash'),
  ).toHaveLength(1);
});

it('does not replay a cancelled upload from a destroyed tab', async () => {
  const leader = await openTab();
  const follower = await openTab();
  workers[0].heldType = 'putBlob';
  let error: unknown;
  void follower
    .putBlob(new Uint8Array([1]), new Uint8Array([10]))
    .catch(value => {
      error = value;
    });
  await vi.advanceTimersByTimeAsync(10);
  follower.destroy();
  leader.destroy();
  await openTab();
  expect(error).toEqual(
    expect.objectContaining({ message: 'ClientDb worker destroyed' }),
  );
  expect(workers[1].messages.some(message => message.type === 'putBlob')).toBe(
    false,
  );
});

it('caps retries when successive leaders close during the same file operation', async () => {
  const leader = await openTab();
  const replacement = await openTab();
  const uploader = await openTab();
  workers[0].heldType = 'blake3Hash';
  heldNewWorkers = 'blake3Hash';
  let error: unknown;
  void uploader.blake3Hash(new Uint8Array([10])).catch(value => {
    error = value;
  });
  await vi.advanceTimersByTimeAsync(10);
  leader.destroy();
  await vi.advanceTimersByTimeAsync(100);
  expect(
    workers[1].messages.filter(message => message.type === 'blake3Hash'),
  ).toHaveLength(1);
  heldNewWorkers = undefined;
  replacement.destroy();
  await vi.advanceTimersByTimeAsync(100);
  expect(error).toEqual(
    expect.objectContaining({
      message: expect.stringContaining('leader changed'),
    }),
  );
  expect(
    workers[2].messages.some(message => message.type === 'blake3Hash'),
  ).toBe(false);
});
