// @vitest-environment jsdom
// @wc-ignore-file
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { useIsLinkedToAccount } from './useIsLinkedToAccount';
import {
  clearManagedAccountBinding,
  writeManagedAccountBinding,
} from '@helpers/managed/binding';
import { noteManagedSessionChanged } from '@helpers/managed/session';

beforeEach(() => clearManagedAccountBinding());
afterEach(cleanup);

it('follows a binding written in this tab', () => {
  const { result } = renderHook(() => useIsLinkedToAccount());
  expect(result.current).toBe(false);

  act(() => writeManagedAccountBinding('a@b.c', 'did:ad:agent:x'));
  expect(result.current).toBe(true);

  act(() => clearManagedAccountBinding());
  expect(result.current).toBe(false);
});

it('follows a binding another tab wrote, which only fires a storage event', () => {
  const { result } = renderHook(() => useIsLinkedToAccount());

  act(() => {
    localStorage.setItem(
      'atomic-managed-account-binding',
      JSON.stringify({ owner_email: 'a@b.c', expected_agent_subject: 'x' }),
    );
    window.dispatchEvent(new StorageEvent('storage', { key: null }));
  });
  expect(result.current).toBe(true);
});

it('re-reads on a session change', () => {
  const { result } = renderHook(() => useIsLinkedToAccount());

  act(() => {
    localStorage.setItem('atomic-managed-device-token', 'tok');
    noteManagedSessionChanged();
  });
  expect(result.current).toBe(true);
  localStorage.removeItem('atomic-managed-device-token');
});
