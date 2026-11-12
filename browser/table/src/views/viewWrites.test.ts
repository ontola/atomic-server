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
