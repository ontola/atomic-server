import { expect, it, vi } from 'vitest';
import { createTableViewWriteQueue } from './viewWrites.js';

it('serializes captured edits and retains a failed write until explicit retry', async () => {
  const queue = createTableViewWriteQueue('table-a');
  const trace: string[] = [];
  let fail = true;
  const first = vi.fn(async () => {
    trace.push('first');
    if (fail) throw Error('offline');
  });
  await queue.enqueue(first);
  await queue.enqueue(async () => {
    trace.push('second');
  });
  expect(trace).toEqual(['first']);
  expect(queue.getSnapshot()).toMatchObject({
    busy: false,
    pending: 2,
    error: { message: 'offline' },
  });
  fail = false;
  await queue.retry();
  expect(trace).toEqual(['first', 'first', 'second']);
  expect(queue.getSnapshot()).toEqual({
    scope: 'table-a',
    busy: false,
    pending: 0,
  });
});

it('keeps concurrent edits in order and joins an in-flight retry', async () => {
  const queue = createTableViewWriteQueue('table');
  let finish!: () => void;
  const trace: string[] = [];
  const pending = queue.enqueue(async () => {
    await new Promise<void>(resolve => {
      finish = resolve;
    });
    trace.push('one');
  });
  await Promise.resolve();
  const second = queue.enqueue(async () => {
    trace.push('two');
  });
  expect(queue.retry()).toBe(pending);
  expect(queue.getSnapshot()).toMatchObject({ busy: true, pending: 2 });
  finish();
  await second;
  expect(trace).toEqual(['one', 'two']);
});

it('does not let a throwing UI observer turn a completed write into a retry', async () => {
  const queue = createTableViewWriteQueue('table');
  queue.subscribe(() => {
    throw Error('observer');
  });
  const write = vi.fn(async () => {});
  await queue.enqueue(write);
  await queue.retry();
  expect(write).toHaveBeenCalledTimes(1);
  expect(queue.getSnapshot().pending).toBe(0);
});

it('checkpoints a prepared identity and confirmed phases across an attachment retry', async () => {
  const queue = createTableViewWriteQueue('table');
  const prepare = vi.fn(async () => ({ id: 'view-one' }));
  const persist = vi.fn(async (_view: { id: string }) => {});
  const attach = vi
    .fn()
    .mockRejectedValueOnce(Error('attach failed'))
    .mockResolvedValue(undefined);
  await queue.enqueue(async intent => {
    const view = await intent.checkpoint('prepared', prepare);
    await intent.checkpoint('persisted', () => persist(view));
    await attach(view);
  });
  await queue.retry();
  expect(prepare).toHaveBeenCalledOnce();
  expect(persist).toHaveBeenCalledOnce();
  expect(attach).toHaveBeenCalledTimes(2);
  expect(attach.mock.calls[0][0]).toBe(attach.mock.calls[1][0]);
});

it('retries failed preparation without losing other successful checkpoints', async () => {
  const queue = createTableViewWriteQueue('table');
  const one = vi.fn(async () => 'one');
  const two = vi
    .fn()
    .mockRejectedValueOnce(Error('prepare failed'))
    .mockResolvedValue('two');
  await queue.enqueue(async intent => {
    await intent.checkpoint('one', one);
    await intent.checkpoint('two', two);
  });
  await queue.retry();
  expect(one).toHaveBeenCalledOnce();
  expect(two).toHaveBeenCalledTimes(2);
  expect(queue.getSnapshot().pending).toBe(0);
});

it('retains a failed table queue across navigation until its captured operation succeeds', async () => {
  const { createTableViewWriteQueues } = await import('./viewWrites.js');
  const queues = createTableViewWriteQueues();
  const a = queues.get('table-a');
  const write = vi
    .fn()
    .mockRejectedValueOnce(Error('offline'))
    .mockResolvedValue(undefined);
  await a.enqueue(write);
  queues.release('table-a');
  expect(queues.get('table-b')).not.toBe(a);
  expect(queues.get('table-a')).toBe(a);
  await queues.get('table-a').retry();
  expect(write).toHaveBeenCalledTimes(2);
  queues.release('table-a');
  expect(queues.get('table-a')).not.toBe(a);
});

it('confirms one tracked write before a later unrelated write finishes', async () => {
  const queue = createTableViewWriteQueue('table');
  let release!: () => void;
  let entered!: () => void;
  const started = new Promise<void>(resolve => {
    entered = resolve;
  });
  const first = queue.enqueueTracked(async () => {});
  const second = queue.enqueueTracked(async () => {
    entered();
    await new Promise<void>(resolve => {
      release = resolve;
    });
  });
  await started;
  await first.wait();
  expect(first.getSnapshot()).toEqual({ status: 'saved' });
  expect(queue.getSnapshot()).toMatchObject({ busy: true, pending: 1 });
  release();
  await second.wait();
});
it('retains a tracked failed intent and its preparation across an explicit retry', async () => {
  const queue = createTableViewWriteQueue('table');
  const prepare = vi.fn(async () => ({ id: 'stable' }));
  const persist = vi
    .fn()
    .mockRejectedValueOnce(Error('offline'))
    .mockResolvedValue(undefined);
  const receipt = queue.enqueueTracked(async context => {
    const value = await context.checkpoint('identity', prepare);
    await persist(value);
  });
  await expect(receipt.wait()).rejects.toThrow('offline');
  expect(receipt.getSnapshot()).toMatchObject({
    status: 'failed',
    error: { message: 'offline' },
  });
  await receipt.retry();
  await receipt.retry();
  expect(prepare).toHaveBeenCalledOnce();
  expect(persist).toHaveBeenCalledTimes(2);
  expect(persist.mock.calls[0][0]).toBe(persist.mock.calls[1][0]);
});
it('does not retry an earlier failed operation on behalf of a blocked tracked write', async () => {
  const queue = createTableViewWriteQueue('table');
  const earlier = vi
    .fn()
    .mockRejectedValueOnce(Error('earlier offline'))
    .mockResolvedValue(undefined);
  const later = vi.fn(async () => {});
  await queue.enqueue(earlier);
  const receipt = queue.enqueueTracked(later);
  await expect(receipt.wait()).rejects.toThrow('earlier view save');
  await expect(receipt.retry()).rejects.toThrow('earlier view save');
  expect(earlier).toHaveBeenCalledOnce();
  expect(later).not.toHaveBeenCalled();
  await queue.retry();
  await receipt.wait();
  expect(earlier).toHaveBeenCalledTimes(2);
  expect(later).toHaveBeenCalledOnce();
});
it('does not attribute a later failure to a tracked operation that already saved', async () => {
  const queue = createTableViewWriteQueue('table');
  const saved = vi.fn(async () => {});
  const first = queue.enqueueTracked(saved);
  const second = queue.enqueueTracked(async () => {
    throw Error('later offline');
  });
  const failed = expect(second.wait()).rejects.toThrow('later offline');
  await first.wait();
  await failed;
  await first.retry();
  expect(saved).toHaveBeenCalledOnce();
  expect(queue.getSnapshot().error?.message).toBe('later offline');
});

it('abandons a blocked, unstarted write without retrying the earlier failure', async () => {
  const queue = createTableViewWriteQueue('table');
  const earlier = vi.fn(async () => {
    throw Error('offline');
  });
  await queue.enqueue(earlier);
  const later = vi.fn(async () => {}),
    receipt = queue.enqueueTracked(later);
  expect(receipt.abandon()).toBe(true);
  await expect(receipt.wait()).rejects.toThrow('abandoned');
  expect(earlier).toHaveBeenCalledOnce();
  expect(later).not.toHaveBeenCalled();
  expect(queue.getSnapshot()).toMatchObject({
    pending: 1,
    error: { message: 'offline' },
  });
});
it('abandons an adapter-confirmed preflight failure and unblocks later work', async () => {
  const queue = createTableViewWriteQueue('table');
  const receipt = queue.enqueueTracked(
    async () => {
      throw Error('target changed');
    },
    { canAbandon: () => true },
  );
  await expect(receipt.wait()).rejects.toThrow('target changed');
  const later = vi.fn(async () => {});
  await queue.enqueue(later);
  expect(receipt.abandon()).toBe(true);
  await queue.retry();
  expect(later).toHaveBeenCalledOnce();
  expect(queue.getSnapshot()).toMatchObject({ pending: 0 });
});
it('cannot abandon a running or potentially partially applied save', async () => {
  const queue = createTableViewWriteQueue('table');
  let release!: () => void;
  const receipt = queue.enqueueTracked(async () => {
    await new Promise<void>(resolve => {
      release = resolve;
    });
    throw Error('save uncertain');
  });
  await Promise.resolve();
  expect(receipt.abandon()).toBe(false);
  release();
  await expect(receipt.wait()).rejects.toThrow('save uncertain');
  expect(receipt.abandon()).toBe(false);
  expect(queue.getSnapshot().pending).toBe(1);
});
