// @vitest-environment jsdom
// @wc-ignore-file
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import { useConfigDraft } from './useConfigDraft';

afterEach(cleanup);

type Config = { folderPrefix: string };

// Stable, as `useValue` returns it: a new object each render would be a new
// config each render.
const DRAFT: Config = { folderPrefix: 'Draft' };
const FINAL: Config = { folderPrefix: 'Final' };

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(r => (resolve = r));

  return { promise, resolve };
}

it('clears the edit once the latest draft is saved', async () => {
  // The editor writes into the resource, so `config` is the draft.
  const { result } = renderHook(() => useConfigDraft<Config>(FINAL));

  act(() => result.current.markEdited());
  expect(result.current.edited).toBe(true);

  await act(() => result.current.commit(FINAL, () => Promise.resolve()));

  expect(result.current.edited).toBe(false);
  expect(result.current.savedConfig).toEqual({ folderPrefix: 'Final' });
});

// plugin.spec "install a plugin": a plugin with no write targets, saved
// offline. The first save settles after the next edit; Save must stay
// available for that edit.
it('keeps a later edit when an earlier save settles after it', async () => {
  const { result } = renderHook(() => useConfigDraft<Config>(FINAL));
  const first = deferred();
  let previous: Config | undefined;

  act(() => result.current.markEdited());
  let saving!: Promise<void>;
  act(() => {
    saving = result.current.commit({ folderPrefix: 'Offline' }, prev => {
      previous = prev;

      return first.promise;
    });
  });
  act(() => result.current.markEdited());

  await act(async () => {
    first.resolve();
    await saving;
  });

  expect(previous).toEqual({ folderPrefix: 'Final' });
  expect(result.current.edited).toBe(true);
  expect(result.current.savedConfig).toEqual({ folderPrefix: 'Offline' });
});

it('keeps the edit when the save fails', async () => {
  const { result } = renderHook(() => useConfigDraft<Config>(DRAFT));

  act(() => result.current.markEdited());
  await act(async () => {
    await expect(
      result.current.commit({ folderPrefix: 'Final' }, () =>
        Promise.reject(new Error('refused')),
      ),
    ).rejects.toThrow('refused');
  });

  expect(result.current.edited).toBe(true);
  expect(result.current.savedConfig).toEqual({ folderPrefix: 'Draft' });
});
