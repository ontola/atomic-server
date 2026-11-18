import { expect, it, vi } from 'vitest';
import { createTableViewInitializer } from './viewInitializer.js';

it('shares one implicit view between concurrent first configuration writes', async () => {
  const initializer = createTableViewInitializer<string>('table:one/implicit');
  let complete!: (subject: string) => void;
  const create = vi.fn(
    () =>
      new Promise<string>(resolve => {
        complete = resolve;
      }),
  );
  const first = initializer.ensure(create),
    second = initializer.ensure(create);
  expect(first).toBe(second);
  await Promise.resolve();
  expect(create).toHaveBeenCalledOnce();
  complete('view:created');
  await expect(first).resolves.toBe('view:created');
  await expect(initializer.ensure(create)).resolves.toBe('view:created');
  expect(create).toHaveBeenCalledOnce();
});

it('allows retry after creation fails without sharing another table or selection epoch', async () => {
  const initializer = createTableViewInitializer<string>('table:one');
  const create = vi
    .fn()
    .mockRejectedValueOnce(Error('Storage unavailable'))
    .mockResolvedValueOnce('view:one');
  await expect(initializer.ensure(create)).rejects.toThrow(
    'Storage unavailable',
  );
  await expect(initializer.ensure(create)).resolves.toBe('view:one');
  const nextEpoch = createTableViewInitializer<string>('table:one');
  await expect(nextEpoch.ensure(async () => 'view:two')).resolves.toBe(
    'view:two',
  );
});

it('does not let an older failed intent clear the new intent after an explicit reset', async () => {
  const initializer = createTableViewInitializer<string>('table:one');
  let reject!: (error: Error) => void;
  const first = initializer.ensure(
    () =>
      new Promise<string>((_resolve, fail) => {
        reject = fail;
      }),
  );
  await Promise.resolve();
  initializer.reset();
  const second = initializer.ensure(async () => 'view:new-intent');
  reject(Error('Old intent failed'));
  await expect(first).rejects.toThrow('Old intent failed');
  await expect(second).resolves.toBe('view:new-intent');
  expect(initializer.ensure(async () => 'wrong-extra-view')).toBe(second);
});
