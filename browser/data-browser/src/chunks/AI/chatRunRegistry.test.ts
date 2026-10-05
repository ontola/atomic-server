import { afterEach, describe, expect, it, vi } from 'vitest';
import type { UIMessageChunk } from 'ai';
import {
  attachRun,
  createRun,
  detachRun,
  getRun,
  type ChatRunHandlers,
} from './chatRunRegistry';

/** A transport whose reply stays open until `finish()` is called. */
function slowTransport() {
  let controller!: ReadableStreamDefaultController<UIMessageChunk>;
  const stream = new ReadableStream<UIMessageChunk>({
    start: c => {
      controller = c;
    },
  });

  return {
    transport: {
      sendMessages: async () => stream,
      reconnectToStream: async () => null,
    },
    push: (chunk: UIMessageChunk) => controller.enqueue(chunk),
    finish: () => controller.close(),
  };
}

const handlers = (): ChatRunHandlers => ({
  onError: vi.fn(),
  onFinish: vi.fn(),
  save: vi.fn(),
});

describe('chatRunRegistry', () => {
  afterEach(() => vi.useRealTimers());

  it('keeps a reply streaming after the page is gone and hands the same run back', async () => {
    const { transport, push, finish } = slowTransport();
    const h = handlers();
    const run = createRun(
      'chat-1',
      transport,
      [],
      () => crypto.randomUUID(),
      h,
    );
    attachRun(run);

    void run.chat.sendMessage({ text: 'build me an app' });
    await vi.waitFor(() => expect(run.chat.status).toBe('submitted'));
    push({ type: 'start' });
    push({ type: 'text-start', id: 't' });
    push({ type: 'text-delta', id: 't', delta: 'Working' });
    await vi.waitFor(() => expect(run.chat.status).toBe('streaming'));

    detachRun(run);

    expect(getRun('chat-1')).toBe(run);
    expect(run.chat.status).toBe('streaming');

    push({ type: 'text-end', id: 't' });
    push({ type: 'finish' });
    finish();
    await vi.waitFor(() => expect(h.onFinish).toHaveBeenCalledTimes(1));

    // Finished while nobody was looking: the registry lets go of it.
    expect(getRun('chat-1')).toBeUndefined();
  });

  it('forgets an idle run once the page is gone', () => {
    const { transport } = slowTransport();
    const run = createRun('chat-2', transport, [], () => 'id', handlers());
    attachRun(run);
    detachRun(run);

    expect(getRun('chat-2')).toBeUndefined();
  });
});
