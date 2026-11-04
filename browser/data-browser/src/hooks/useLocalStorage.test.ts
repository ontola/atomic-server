// @vitest-environment jsdom
// @wc-ignore-file
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import { useLocalStorage } from './useLocalStorage';

afterEach(() => {
  cleanup();
  window.localStorage.clear();
});

it('keeps one setter identity across writes', () => {
  const { result } = renderHook(() => useLocalStorage('test.key', 0));
  const firstSetter = result.current[1];

  act(() => result.current[1](1));
  act(() => result.current[1](n => n + 1));

  expect(result.current[0]).toBe(2);
  expect(result.current[1]).toBe(firstSetter);
  expect(window.localStorage.getItem('test.key')).toBe('2');
});

it('re-reads storage when the key changes', () => {
  window.localStorage.setItem('test.a', JSON.stringify('A'));
  window.localStorage.setItem('test.b', JSON.stringify('B'));

  const { result, rerender } = renderHook(
    ({ k }) => useLocalStorage(k, 'none'),
    { initialProps: { k: 'test.a' } },
  );

  expect(result.current[0]).toBe('A');

  rerender({ k: 'test.b' });
  expect(result.current[0]).toBe('B');

  // The functional update starts from the new key's value, not the old one.
  act(() => result.current[1](prev => `${prev}!`));
  expect(window.localStorage.getItem('test.b')).toBe('"B!"');
  expect(window.localStorage.getItem('test.a')).toBe('"A"');

  rerender({ k: 'test.missing' });
  expect(result.current[0]).toBe('none');
});

it('applies functional updates to a value another hook wrote', () => {
  const a = renderHook(() => useLocalStorage('test.shared', 0));
  const b = renderHook(() => useLocalStorage('test.shared', 0));

  act(() => a.result.current[1](5));
  act(() => b.result.current[1](n => n + 1));

  expect(a.result.current[0]).toBe(6);
  expect(b.result.current[0]).toBe(6);
});
