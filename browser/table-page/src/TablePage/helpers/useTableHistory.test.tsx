// @vitest-environment jsdom
// @wc-ignore-file
import { act, cleanup, renderHook } from '@testing-library/react';
import type { Resource } from '@tomic/react';
import { afterEach, expect, it, vi } from 'vitest';
import {
  createResourceCreatedHistoryItem,
  useTableHistory,
} from './useTableHistory.js';

const { getResourceLoading } = vi.hoisted(() => ({
  getResourceLoading: vi.fn(),
}));
vi.mock('@tomic/react', async importOriginal => ({
  ...(await importOriginal<typeof import('@tomic/react')>()),
  useStore: () => ({ getResourceLoading }),
}));

afterEach(cleanup);

it('retains the failed and unattempted undo steps without repeating the successful step', async () => {
  const failure = Error('Cannot undo this row yet');
  const first = vi.fn().mockResolvedValue(undefined);
  const second = vi
    .fn()
    .mockRejectedValueOnce(failure)
    .mockResolvedValue(undefined);
  const third = vi.fn().mockResolvedValue(undefined);
  const destroy = { first, second, third };
  getResourceLoading.mockImplementation((subject: keyof typeof destroy) => ({
    destroy: destroy[subject],
  }));
  const invalidate = vi.fn();
  const { result } = renderHook(() => useTableHistory(invalidate));
  act(() =>
    result.current.addItemsToHistoryStack(
      Object.keys(destroy).map(subject =>
        createResourceCreatedHistoryItem({ subject } as Resource),
      ),
    ),
  );

  await act(async () => {
    await expect(result.current.undoLastItem()).rejects.toThrow(failure);
  });
  expect(third).not.toHaveBeenCalled();

  await act(async () => {
    await result.current.undoLastItem();
  });
  expect(first).toHaveBeenCalledOnce();
  expect(second).toHaveBeenCalledTimes(2);
  expect(third).toHaveBeenCalledOnce();
});
