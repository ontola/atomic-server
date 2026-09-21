// @vitest-environment jsdom
import React, { useState } from 'react';
import { act, renderHook } from '@testing-library/react';
import { createMemoryHistory } from '@tanstack/react-router';
import { beforeEach, expect, it, vi } from 'vitest';
import { useMobilePanelHistory } from './useMobilePanelHistory';

const fixture = vi.hoisted(() => ({ history: undefined as unknown }));
vi.mock('@tanstack/react-router', async importOriginal => ({
  ...(await importOriginal<typeof import('@tanstack/react-router')>()),
  useRouter: () => fixture,
}));
let history: ReturnType<typeof createMemoryHistory>;
beforeEach(() => {
  history = createMemoryHistory({ initialEntries: ['/previous', '/page'] });
  fixture.history = history;
});

it('Back closes chat on the same page, including under StrictMode', () => {
  const { result } = renderHook(
    () => {
      const [open, setOpen] = useState(true);
      useMobilePanelHistory(open, () => setOpen(false));

      return open;
    },
    { wrapper: React.StrictMode },
  );
  expect(history.length).toBe(3);
  act(() => history.back());
  expect(result.current).toBe(false);
  expect(history.location.href).toBe('/page');
  act(() => history.back());
  expect(history.location.href).toBe('/previous');
});

it('closing explicitly removes only its own history entry', () => {
  const { rerender } = renderHook(
    ({ open }) => {
      useMobilePanelHistory(open, vi.fn());
    },
    { initialProps: { open: true } },
  );
  rerender({ open: false });
  expect(history.location.href).toBe('/page');
  act(() => history.back());
  expect(history.location.href).toBe('/previous');
});

it('navigation closes the panel without returning from the destination', () => {
  const close = vi.fn();
  const { rerender } = renderHook(
    ({ open }) => useMobilePanelHistory(open, close),
    {
      initialProps: { open: true },
    },
  );
  act(() => history.push('/app/settings'));
  expect(close).toHaveBeenCalledOnce();
  rerender({ open: false });
  expect(history.location.href).toBe('/app/settings');
});
