// @vitest-environment jsdom
// @wc-ignore-file
import { renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { settings, navigate } = vi.hoisted(() => ({
  settings: { viewTransitionsEnabled: false },
  navigate: vi.fn(async () => undefined),
}));

vi.mock('react-dom', () => ({
  flushSync: (fn: () => void) => fn(),
}));

vi.mock('../helpers/AppSettings', () => ({
  useSettings: () => settings,
}));

vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => navigate,
  useRouter: () => ({ history: { back: vi.fn(), forward: vi.fn() } }),
}));

import { resetViewTransitionQueue } from '../helpers/viewTransition';
import { useNavigateWithTransition } from './useNavigateWithTransition';

/** Minimal stand-in for the real `ViewTransition` the UA hands back. */
function fakeTransition(
  callbackOptions?: ViewTransitionUpdateCallback | StartViewTransitionOptions,
): ViewTransition {
  const update =
    typeof callbackOptions === 'function'
      ? callbackOptions
      : callbackOptions?.update;
  const done = Promise.resolve(update?.()).then(() => undefined);

  return {
    ready: Promise.resolve(),
    finished: done,
    updateCallbackDone: done,
    skipTransition: vi.fn(),
    types: new Set<string>() as ViewTransition['types'],
  };
}

const startViewTransition = vi.fn(fakeTransition);

describe('useNavigateWithTransition', () => {
  beforeEach(() => {
    resetViewTransitionQueue();
    navigate.mockClear();
    startViewTransition.mockClear();
    // jsdom has no view transitions, so stand the API in: the only thing
    // deciding whether we take that path should be the setting.
    document.startViewTransition = startViewTransition;
  });

  afterEach(() => {
    Reflect.deleteProperty(document, 'startViewTransition');
    resetViewTransitionQueue();
  });

  // Transitions are opt-in since #1563 — they still break on Firefox and
  // Android. A default that silently flips back would be invisible in review,
  // so pin both sides of it here.
  it('navigates without a view transition when the user has not opted in', async () => {
    settings.viewTransitionsEnabled = false;

    const { result } = renderHook(() => useNavigateWithTransition());
    await result.current('/app/drive');

    expect(navigate).toHaveBeenCalledWith({ to: '/app/drive' });
    expect(startViewTransition).not.toHaveBeenCalled();
  });

  it('wraps the navigation in a view transition once the user opts in', async () => {
    settings.viewTransitionsEnabled = true;

    const { result } = renderHook(() => useNavigateWithTransition());
    await result.current('/app/drive');

    expect(navigate).toHaveBeenCalledWith({ to: '/app/drive' });
    expect(startViewTransition).toHaveBeenCalledOnce();
  });
});
