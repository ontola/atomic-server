// @vitest-environment jsdom
// @wc-ignore-file
import { act, renderHook } from '@testing-library/react';
import { expect, it } from 'vitest';
import {
  dismissUiHint,
  hideHoverUiHint,
  registerUiHintTarget,
  showUiHint,
  useUiHint,
} from './uiHint';

it('shows a hint on its target and goes away when dismissed', () => {
  const { result } = renderHook(() => useUiHint('ai-button'));
  expect(result.current.text).toBeUndefined();

  act(() => {
    showUiHint('ai-button', 'Here', { force: true });
  });
  expect(result.current.text).toBe('Here');

  act(() => dismissUiHint());
  expect(result.current.text).toBeUndefined();
});

it('refuses a target that is not on screen', () => {
  expect(showUiHint('share-button', 'Here')).toBe(false);
  const el = document.createElement('div');
  el.getClientRects = () => [{}] as unknown as DOMRectList;
  const unregister = registerUiHintTarget('share-button', el);
  expect(showUiHint('share-button', 'Here')).toBe(true);
  unregister();
  dismissUiHint();
});

it('shows a hover hint until it leaves, but never over a sticky one', () => {
  const { result } = renderHook(() => useUiHint('ai-button'));

  act(() => {
    showUiHint('ai-button', 'Hover', { force: true, hover: true });
  });
  expect(result.current.text).toBe('Hover');
  act(() => hideHoverUiHint());
  expect(result.current.text).toBeUndefined();

  act(() => {
    showUiHint('ai-button', 'Click', { force: true, nudge: true });
    showUiHint('ai-button', 'Hover', { force: true, hover: true });
  });
  expect(result.current.text).toBe('Click');
  expect(result.current.nudge).toBe(1);
  act(() => hideHoverUiHint());
  expect(result.current.text).toBe('Click');
  act(() => dismissUiHint());
});
