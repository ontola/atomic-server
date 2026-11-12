import { expect, it, vi } from 'vitest';
import { createTableDraftCommit } from './draftCommit.js';

it('does not report saved until persistence confirms, and blocks duplicate submissions', async () => {
  const commit = createTableDraftCommit('class:one/property:one');
  let complete!: () => void;
  const pending = new Promise<void>(resolve => {
    complete = resolve;
  });
  const save = vi.fn(async () => {
    await pending;

    return 'property:saved';
  });
  const first = commit.run(save);
  expect(commit.getSnapshot().busy).toBe(true);
  await expect(commit.run(save)).resolves.toEqual({ status: 'blocked' });
  expect(save).toHaveBeenCalledOnce();
  complete();
  await expect(first).resolves.toEqual({
    status: 'saved',
    value: 'property:saved',
  });
  expect(commit.getSnapshot()).toEqual({
    scope: 'class:one/property:one',
    busy: false,
  });
});

it('reports save errors and allows an explicit retry', async () => {
  const commit = createTableDraftCommit();
  const draft = { name: 'Retained name', minimum: 0 };
  const failure = Error('Class write failed');
  await expect(
    commit.run(async () => {
      throw failure;
    }),
  ).resolves.toEqual({ status: 'failed', error: failure });
  expect(commit.getSnapshot().error).toBe(failure);
  await expect(commit.run(async () => draft)).resolves.toEqual({
    status: 'saved',
    value: draft,
  });
  expect(commit.getSnapshot().error).toBeUndefined();
});

it('blocks invalid forms and captures synchronous failures', async () => {
  const commit = createTableDraftCommit();
  const save = vi.fn();
  await expect(commit.run(save, false)).resolves.toEqual({ status: 'blocked' });
  expect(save).not.toHaveBeenCalled();
  await expect(
    commit.run(() => {
      throw 'Invalid metadata';
    }),
  ).resolves.toMatchObject({
    status: 'failed',
    error: { message: 'Invalid metadata' },
  });
});

it('does not turn a stored success into a failure when a UI observer throws', async () => {
  const commit = createTableDraftCommit();
  commit.subscribe(() => {
    throw Error('Observer failed');
  });
  await expect(commit.run(async () => 'saved')).resolves.toEqual({
    status: 'saved',
    value: 'saved',
  });
  expect(commit.getSnapshot().busy).toBe(false);
});

it('retries a failed attachment with the same prepared identity', async () => {
  const commit = createTableDraftCommit('table-class');
  const draft = { name: 'New column' };
  const prepare = vi.fn(async () => 'property:created');
  const attach = vi
    .fn()
    .mockRejectedValueOnce(Error('Class save failed'))
    .mockResolvedValueOnce('property:created');
  await expect(
    commit.runPrepared(draft, prepare, attach),
  ).resolves.toMatchObject({ status: 'failed' });
  expect(commit.hasPrepared(draft)).toBe(true);
  await expect(commit.runPrepared(draft, prepare, attach)).resolves.toEqual({
    status: 'saved',
    value: 'property:created',
  });
  expect(prepare).toHaveBeenCalledOnce();
  expect(attach).toHaveBeenNthCalledWith(1, 'property:created');
  expect(attach).toHaveBeenNthCalledWith(2, 'property:created');
});

it('does not checkpoint failed preparation or conflate separate working drafts', async () => {
  const commit = createTableDraftCommit();
  const draft = { name: 'Same label' },
    another = { name: 'Same label' };
  const prepare = vi
    .fn()
    .mockRejectedValueOnce(Error('Property save failed'))
    .mockResolvedValueOnce('property:one')
    .mockResolvedValueOnce('property:two');
  const attach = vi.fn(async value => value);
  await commit.runPrepared(draft, prepare, attach);
  expect(commit.hasPrepared(draft)).toBe(false);
  await expect(commit.runPrepared(draft, prepare, attach)).resolves.toEqual({
    status: 'saved',
    value: 'property:one',
  });
  await expect(commit.runPrepared(another, prepare, attach)).resolves.toEqual({
    status: 'saved',
    value: 'property:two',
  });
});

it.each([false, true])(
  'suppresses stale completion actions when the editor scope changes (failure: %s)',
  async fail => {
    const commit = createTableDraftCommit('old-property');
    let complete!: () => void;
    const pending = new Promise<void>(resolve => {
      complete = resolve;
    });
    const save = commit.run(async () => {
      await pending;
      if (fail) throw Error('Old scope failed');

      return 'old-property';
    });
    commit.invalidate();
    expect(commit.getSnapshot().busy).toBe(true);
    complete();
    await expect(save).resolves.toEqual({ status: 'stale' });
    expect(commit.getSnapshot().error).toBeUndefined();
  },
);
