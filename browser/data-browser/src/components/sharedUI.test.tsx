// @vitest-environment jsdom
import React from 'react';
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import { ControlLockProvider } from '../hooks/useControlLock';
import {
  useControlLock,
  useHasControlLock,
} from '@tomic/ui/hooks/useControlLock';
import { DialogTreeContextProvider } from './Dialog/dialogContext';
import { useDialogTreeInfo } from '@tomic/ui/components/Dialog/dialogContext';
import { CurrentBackgroundColor } from '../globalCssVars';
import { CurrentBackgroundColor as sharedBackgroundColor } from '@tomic/ui/globalCssVars';

afterEach(cleanup);

it('host controls and extracted overlays observe the same keyboard lock', () => {
  const { result, rerender } = renderHook(
    ({ open }) => {
      useControlLock(open);

      return useHasControlLock();
    },
    { initialProps: { open: false }, wrapper: ControlLockProvider },
  );
  expect(result.current).toBe(false);
  rerender({ open: true });
  expect(result.current).toBe(true);
  rerender({ open: false });
  expect(result.current).toBe(false);
});

it('a popup in the shared package participates in the host dialog tree', () => {
  const { result } = renderHook(() => useDialogTreeInfo(), {
    wrapper: ({ children }) => (
      <DialogTreeContextProvider>{children}</DialogTreeContextProvider>
    ),
  });
  expect(result.current.inDialog).toBe(true);
  act(() => result.current.setHasOpenInnerPopup(true));
  expect(result.current.hasOpenInnerPopup).toBe(true);
});

it('host surfaces and extracted overlays share the same generated CSS variable', () => {
  expect(CurrentBackgroundColor).toBe(sharedBackgroundColor);
});
