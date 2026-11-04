// @vitest-environment jsdom
// @wc-ignore-file
import { act, renderHook } from '@testing-library/react';
import { expect, it } from 'vitest';
import {
  dismissDriveSwitcherHint,
  showDriveSwitcherHint,
  useDriveSwitcherHint,
} from './driveSwitcherHint';

it('shows once after a creation and goes away when dismissed', () => {
  const { result } = renderHook(() => useDriveSwitcherHint());
  expect(result.current).toBe(false);

  act(() => showDriveSwitcherHint());
  expect(result.current).toBe(true);

  act(() => dismissDriveSwitcherHint());
  expect(result.current).toBe(false);
});
