// @vitest-environment jsdom
// @wc-ignore-file
import { act, cleanup, renderHook } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, expect, it } from 'vitest';
import { SettingsContext } from '../helpers/AppSettings';
import { driveHistoryKey, useDriveHistory } from './useDriveHistory';

afterEach(() => {
  cleanup();
  window.localStorage.clear();
});

const A = 'did:ad:agent:a';
const B = 'did:ad:agent:b';

function wrapperFor(getSubject: () => string | undefined) {
  return ({ children }: { children: ReactNode }) => {
    const subject = getSubject();

    return (
      <SettingsContext.Provider
        value={{ agent: subject ? { subject } : undefined } as never}
      >
        {children}
      </SettingsContext.Provider>
    );
  };
}

it('does not show one identity the drives of another', () => {
  const a = renderHook(() => useDriveHistory(), {
    wrapper: wrapperFor(() => A),
  });

  act(() => a.result.current[1]('https://example.com/drive-a'));
  expect(a.result.current[0]).toEqual(['https://example.com/drive-a']);

  const b = renderHook(() => useDriveHistory(), {
    wrapper: wrapperFor(() => B),
  });

  expect(b.result.current[0]).toEqual([]);
  expect(window.localStorage.getItem(driveHistoryKey(B))).toBeNull();
});

it('switches history when the agent changes without a remount', () => {
  let subject = A;
  const hook = renderHook(() => useDriveHistory(), {
    wrapper: wrapperFor(() => subject),
  });

  act(() => hook.result.current[1]('https://example.com/drive-a'));

  subject = B;
  hook.rerender();
  expect(hook.result.current[0]).toEqual([]);

  act(() => hook.result.current[1]('https://example.com/drive-b'));
  expect(hook.result.current[0]).toEqual(['https://example.com/drive-b']);

  subject = A;
  hook.rerender();
  expect(hook.result.current[0]).toEqual(['https://example.com/drive-a']);
});

it('keeps no history without an agent', () => {
  const hook = renderHook(() => useDriveHistory(), {
    wrapper: wrapperFor(() => undefined),
  });

  act(() => hook.result.current[1]('https://example.com/x'));
  expect(hook.result.current[0]).toEqual([]);
  expect(window.localStorage.length).toBe(0);
});
