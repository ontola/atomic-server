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
