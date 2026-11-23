// @vitest-environment jsdom
import { afterEach, describe, it, expect, vi } from 'vitest';
import React, { StrictMode, useContext, useState } from 'react';
import {
  act,
  cleanup,
  fireEvent,
  render,
  renderHook,
  screen,
} from '@testing-library/react';
import {
  DialogContext,
  DialogGlobalContextProvider,
  useDialogGlobalContext,
} from './DialogGlobalContextProvider';

afterEach(cleanup);

function StackItem({ name }: { name: string }) {
  const { isTopLevel, isTopLevelNow } = useDialogGlobalContext(true);

  return (
    <button
      data-top-level={isTopLevel}
      onClick={() => {
        if (isTopLevelNow())
          document.dispatchEvent(new Event('dialog-dismissed'));
      }}
    >
      {name}
    </button>
  );
}

it.each(['Cancel', 'Save'])(
  'restores live and rendered dismissal when %s unmounts an open dialog',
  action => {
    const dismissed = vi.fn();
    document.addEventListener('dialog-dismissed', dismissed);

    function Host() {
      const [open, setOpen] = useState(true);

      return (
        <DialogGlobalContextProvider>
          <StackItem name='Underlying dialog' />
          {open && <StackItem name='Property dialog' />}
          <button onClick={() => setOpen(false)}>{action}</button>
        </DialogGlobalContextProvider>
      );
    }

    try {
      render(
        <StrictMode>
          <Host />
        </StrictMode>,
      );
      const underlying = screen.getByRole('button', {
        name: 'Underlying dialog',
      });
      expect(underlying.getAttribute('data-top-level')).toBe('false');
      fireEvent.click(underlying);
      expect(dismissed).not.toHaveBeenCalled();
      fireEvent.click(screen.getByRole('button', { name: action }));
      expect(underlying.getAttribute('data-top-level')).toBe('true');
      fireEvent.click(underlying);
      expect(dismissed).toHaveBeenCalledOnce();
    } finally {
      document.removeEventListener('dialog-dismissed', dismissed);
    }
  },
);

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
