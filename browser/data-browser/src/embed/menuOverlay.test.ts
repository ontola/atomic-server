// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  consumeMenu,
  isMenuItemTarget,
  menuConsumed,
  reportMenuState,
  watchIdle,
} from './menuOverlay';

describe('watchIdle', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('waits for the menu to have been busy before it can be idle', () => {
    const onIdle = vi.fn();
    const stop = watchIdle({ busy: () => false, grace: () => 0, onIdle });

    vi.advanceTimersByTime(2000);
    expect(onIdle).not.toHaveBeenCalled();
    stop();
  });

  it('is idle at once when the grace is zero', () => {
    let busy = true;
    const onIdle = vi.fn();

    watchIdle({ busy: () => busy, grace: () => 0, onIdle });
    vi.advanceTimersByTime(200);
    expect(onIdle).not.toHaveBeenCalled();
    busy = false;
    vi.advanceTimersByTime(100);
    expect(onIdle).toHaveBeenCalledTimes(1);
  });

  it('gives a dialog opened after the menu closed time to appear', () => {
    let busy = true;
    const onIdle = vi.fn();

    watchIdle({ busy: () => busy, grace: () => 900, onIdle });
    vi.advanceTimersByTime(100);
    busy = false;
    vi.advanceTimersByTime(500);
    busy = true;
    vi.advanceTimersByTime(2000);
    expect(onIdle).not.toHaveBeenCalled();
    busy = false;
    vi.advanceTimersByTime(1000);
    expect(onIdle).toHaveBeenCalledTimes(1);
  });
});

describe('menu bookkeeping', () => {
  it('remembers a used menu', () => {
    expect(menuConsumed('a')).toBe(false);
    consumeMenu('a');
    expect(menuConsumed('a')).toBe(true);
  });

  it('knows a tap on an item', () => {
    document.body.innerHTML =
      '<div role=menu><button role=menuitem>x</button></div><p>y</p>';
    expect(isMenuItemTarget(document.querySelector('button'))).toBe(true);
    expect(isMenuItemTarget(document.querySelector('p'))).toBe(false);
  });

  it('tells the app through the Flutter channel', () => {
    const postMessage = vi.fn();

    window.AtomicFlutter = { postMessage };
    reportMenuState('closed');
    expect(postMessage).toHaveBeenCalledWith(
      JSON.stringify({ method: 'menuState', state: 'closed' }),
    );
  });
});
