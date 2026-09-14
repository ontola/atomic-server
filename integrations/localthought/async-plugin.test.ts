import { expect, it, vi } from 'vitest';
import { runWithAsyncReads } from './async-plugin';

it('resumes synchronous provider reads without dispatching an earlier request twice', async () => {
  const request = vi.fn(async (id: string) => id.toUpperCase());
  const run = ({ http }: { http: (id: string) => string }) => [
    http('first'),
    http('second'),
  ];
  expect(await runWithAsyncReads(run, {}, request)).toEqual([
    'FIRST',
    'SECOND',
  ]);
  expect(request.mock.calls).toEqual([['first'], ['second']]);
});

it('propagates an uncertain read and never retries it', async () => {
  const request = vi.fn(async () => {
    throw new Error('Connection lost');
  });
  await expect(
    runWithAsyncReads(({ http }) => http('x'), {}, request),
  ).rejects.toThrow('Connection lost');
  expect(request).toHaveBeenCalledTimes(1);
});

it('bounds a provider that never finishes reading', async () => {
  const request = vi.fn(async () => 'ok');
  await expect(
    runWithAsyncReads(
      ({ http }) => {
        for (let i = 0; i < 4; i++) http(String(i));
      },
      {},
      request,
      3,
    ),
  ).rejects.toThrow('request limit');
  expect(request).toHaveBeenCalledTimes(3);
});

it('does not hide provider failures', async () => {
  await expect(
    runWithAsyncReads(
      () => {
        throw new Error('Invalid schema');
      },
      {},
      vi.fn(),
    ),
  ).rejects.toThrow('Invalid schema');
});
