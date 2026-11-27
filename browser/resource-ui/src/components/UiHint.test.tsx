// @vitest-environment jsdom
// @wc-ignore-file
import { useLayoutEffect, type PropsWithChildren, type ReactNode } from 'react';
import { act, cleanup, render } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { ThemeProvider, type DefaultTheme } from 'styled-components';
import { UiHint } from './UiHint';
import {
  dismissUiHint,
  isUiHintTargetShown,
  showUiHint,
} from '../hooks/uiHint';

vi.mock('@tomic/ui/components/Popover', () => ({
  Popover: ({
    Trigger,
    open,
    children,
  }: PropsWithChildren<{ Trigger: ReactNode; open?: boolean }>) => (
    <>
      {Trigger}
      {open && <div>{children}</div>}
    </>
  ),
}));
vi.mock('@radix-ui/react-popover', () => ({
  Anchor: () => null,
  Arrow: ({ children }: PropsWithChildren) => children,
}));
vi.mock('@tomic/ui/components/IconButton/IconButton', () => ({
  IconButton: ({ children }: PropsWithChildren) => <button>{children}</button>,
}));

const theme = {
  colors: { text: '#000', bgBody: '#fff', bg2: '#eee' },
  size: (n = 1) => `${n * 4}px`,
} as unknown as DefaultTheme;

afterEach(() => {
  cleanup();
  act(() => dismissUiHint());
});

it('registers a visible target before layout-time interactions can request a hint', () => {
  const requested = vi.fn();

  function OnArrival() {
    useLayoutEffect(() => {
      requested(showUiHint('new-row', 'Make something here'));
    }, []);

    return (
      <UiHint target='new-row'>
        <button
          ref={el => {
            if (el) el.getClientRects = () => [{}] as unknown as DOMRectList;
          }}
        >
          New
        </button>
      </UiHint>
    );
  }

  const view = render(
    <ThemeProvider theme={theme}>
      <OnArrival />
    </ThemeProvider>,
  );
  expect(requested).toHaveBeenCalledWith(true);
  expect(view.getByTestId('ui-hint-new-row').textContent).toBe(
    'Make something here',
  );
  view.unmount();
  expect(isUiHintTargetShown('new-row')).toBe(false);
});
