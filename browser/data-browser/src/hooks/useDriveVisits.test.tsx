// @vitest-environment jsdom
// @wc-ignore-file
import { act, cleanup, renderHook } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, expect, it } from 'vitest';
import { SettingsContext } from '../helpers/AppSettings';
import { useDriveVisits } from './useDriveVisits';

afterEach(() => {
  cleanup();
  window.localStorage.clear();
});

const wrapperFor = (subject?: string) =>
  function Wrapper({ children }: { children: ReactNode }) {
    return (
      <SettingsContext.Provider
        value={{ agent: subject ? { subject } : undefined } as never}
      >
        {children}
      </SettingsContext.Provider>
    );
  };

it('does not show one identity the visits of another', () => {
  const a = renderHook(() => useDriveVisits(), {
    wrapper: wrapperFor('did:ad:agent:a'),
  });

  act(() => a.result.current[1]('did:ad:drive:one'));
  expect(Object.keys(a.result.current[0])).toHaveLength(1);

  const b = renderHook(() => useDriveVisits(), {
    wrapper: wrapperFor('did:ad:agent:b'),
  });

  expect(b.result.current[0]).toEqual({});
});

it('records nothing without an agent', () => {
  const hook = renderHook(() => useDriveVisits(), { wrapper: wrapperFor() });

  act(() => hook.result.current[1]('did:ad:drive:one'));
  expect(hook.result.current[0]).toEqual({});
  expect(window.localStorage.length).toBe(0);
});
