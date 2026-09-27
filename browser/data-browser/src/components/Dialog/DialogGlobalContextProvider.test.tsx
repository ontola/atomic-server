// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import React, { useContext } from 'react';
import { act, renderHook } from '@testing-library/react';
import {
  DialogContext,
  DialogGlobalContextProvider,
  useDialogGlobalContext,
} from './DialogGlobalContextProvider';

/**
 * A dialog decides whether to answer an Escape while the key is being handled,
 * which is not a moment React has re-rendered for. `calendar.spec:106` opened a
 * row on top of a day list and pressed Escape once: both dialogs closed.
 */
const openDialog = () =>
  renderHook(
    () => ({
      dialog: useDialogGlobalContext(true),
      setDialogOpen: useContext(DialogContext).setDialogOpen,
    }),
    {
      wrapper: ({ children }: { children: React.ReactNode }) =>
        React.createElement(DialogGlobalContextProvider, null, children),
    },
  );

describe('useDialogGlobalContext', () => {
  it('knows it is on top while it is the only dialog', () => {
    const { result } = openDialog();

    act(() => undefined);
    expect(result.current.dialog.isTopLevel).toBe(true);
    expect(result.current.dialog.isTopLevelNow()).toBe(true);
  });

  it('stops claiming the top the moment another dialog opens, not the render after', () => {
    const { result } = openDialog();

    act(() => undefined);

    act(() => {
      result.current.setDialogOpen('stacked-on-top', true);

      // Still inside the same tick: React has not re-rendered, so the rendered
      // flag is the one that was true a moment ago. Anything acting on a
      // keystroke now has to see the stack as it is.
      expect(result.current.dialog.isTopLevel).toBe(true);
      expect(result.current.dialog.isTopLevelNow()).toBe(false);
    });

    expect(result.current.dialog.isTopLevel).toBe(false);
    expect(result.current.dialog.isTopLevelNow()).toBe(false);
  });

  it('has the top back as soon as the dialog above it closes', () => {
    const { result } = openDialog();

    act(() => {
      result.current.setDialogOpen('stacked-on-top', true);
    });
    expect(result.current.dialog.isTopLevelNow()).toBe(false);

    act(() => {
      result.current.setDialogOpen('stacked-on-top', false);
      expect(result.current.dialog.isTopLevelNow()).toBe(true);
    });
  });
});
