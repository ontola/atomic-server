import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  isChromeDesktop,
  resetViewTransitionQueue,
  wrapWithViewTransition,
} from './viewTransition';
import {
  getTransitionName,
  getTransitionStyle,
  PAGE_TITLE_TRANSITION_TAG,
  RESOURCE_PAGE_TRANSITION_TAG,
  transitionName,
} from './transitionName';

vi.mock('react-dom', () => ({
  flushSync: (fn: () => void) => fn(),
}));

const CHROME_DESKTOP_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const ANDROID_CHROME_UA =
  'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.6778.135 Mobile Safari/537.36';
const FIREFOX_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:133.0) Gecko/20100101 Firefox/133.0';
const SAFARI_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15';
const IOS_CHROME_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/131.0.6778.73 Mobile/15E148 Safari/604.1';

function stubChromeDesktop(overrides: { webdriver?: boolean } = {}) {
  vi.stubGlobal('navigator', {
    webdriver: overrides.webdriver ?? false,
    userAgent: CHROME_DESKTOP_UA,
    userAgentData: {
      mobile: false,
      brands: [
        { brand: 'Google Chrome', version: '131' },
        { brand: 'Chromium', version: '131' },
      ],
    },
  });
}

describe('transitionName helpers', () => {
  it('emits a hashed name plus a view-transition-class for the tag', () => {
    const subject = 'did:ad:example';
    const name = getTransitionName(RESOURCE_PAGE_TRANSITION_TAG, subject);

    expect(transitionName(RESOURCE_PAGE_TRANSITION_TAG, subject)).toBe(
      `view-transition-name: ${name}; view-transition-class: ${RESOURCE_PAGE_TRANSITION_TAG}`,
    );
    expect(getTransitionStyle(PAGE_TITLE_TRANSITION_TAG, subject)).toEqual({
      viewTransitionName: getTransitionName(PAGE_TITLE_TRANSITION_TAG, subject),
      viewTransitionClass: PAGE_TITLE_TRANSITION_TAG,
    });
  });

  it('falls back when there is no subject', () => {
    expect(transitionName(RESOURCE_PAGE_TRANSITION_TAG, undefined)).toBe(
      'view-transition-name: none',
    );
    expect(getTransitionStyle(RESOURCE_PAGE_TRANSITION_TAG, undefined)).toEqual(
      {},
    );
  });
});

describe('isChromeDesktop', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('is true for desktop Chrome client hints', () => {
    stubChromeDesktop();

    expect(isChromeDesktop()).toBe(true);
  });

  it('is true for desktop Chromium client hints without a Google Chrome brand', () => {
    vi.stubGlobal('navigator', {
      userAgent: CHROME_DESKTOP_UA,
      userAgentData: {
        mobile: false,
        brands: [{ brand: 'Chromium', version: '131' }],
      },
    });

    expect(isChromeDesktop()).toBe(true);
  });

  it('falls back to the user agent when client hints are missing', () => {
    vi.stubGlobal('navigator', { userAgent: CHROME_DESKTOP_UA });

    expect(isChromeDesktop()).toBe(true);
  });

  it('is false for Android Chrome', () => {
    vi.stubGlobal('navigator', {
      userAgent: ANDROID_CHROME_UA,
      userAgentData: {
        mobile: true,
        brands: [
          { brand: 'Google Chrome', version: '131' },
          { brand: 'Chromium', version: '131' },
        ],
      },
    });

    expect(isChromeDesktop()).toBe(false);
  });

  it('is false for Firefox', () => {
    vi.stubGlobal('navigator', { userAgent: FIREFOX_UA });

    expect(isChromeDesktop()).toBe(false);
  });

  it('is false for Safari desktop', () => {
    vi.stubGlobal('navigator', { userAgent: SAFARI_UA });

    expect(isChromeDesktop()).toBe(false);
  });

  it('is false for Chrome on iOS', () => {
    vi.stubGlobal('navigator', { userAgent: IOS_CHROME_UA });

    expect(isChromeDesktop()).toBe(false);
  });
});

describe('wrapWithViewTransition', () => {
  beforeEach(() => {
    resetViewTransitionQueue();
    vi.useFakeTimers();
    stubChromeDesktop();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    resetViewTransitionQueue();
  });

  it('runs the callback directly when the API is missing', async () => {
    vi.stubGlobal('document', {});
    const cb = vi.fn(async () => undefined);
    const wrapped = wrapWithViewTransition(false, cb);

    await wrapped();

    expect(cb).toHaveBeenCalledOnce();
  });

  it('runs the callback directly on Android Chrome even when enabled', async () => {
    vi.stubGlobal('navigator', {
      webdriver: false,
      userAgent: ANDROID_CHROME_UA,
      userAgentData: {
        mobile: true,
        brands: [
          { brand: 'Google Chrome', version: '131' },
          { brand: 'Chromium', version: '131' },
        ],
      },
    });
    const startViewTransition = vi.fn();
    vi.stubGlobal('document', { startViewTransition });
    const cb = vi.fn(async () => undefined);
    const wrapped = wrapWithViewTransition(false, cb);

    await wrapped();

    expect(cb).toHaveBeenCalledOnce();
    expect(startViewTransition).not.toHaveBeenCalled();
  });

  it('runs the callback directly on Firefox even when enabled', async () => {
    vi.stubGlobal('navigator', { webdriver: false, userAgent: FIREFOX_UA });
    const startViewTransition = vi.fn();
    vi.stubGlobal('document', { startViewTransition });
    const cb = vi.fn(async () => undefined);
    const wrapped = wrapWithViewTransition(false, cb);

    await wrapped();

    expect(cb).toHaveBeenCalledOnce();
    expect(startViewTransition).not.toHaveBeenCalled();
  });

  it('still wraps on a non-Chrome browser when forceViewTransitions is set', async () => {
    vi.stubGlobal('navigator', { webdriver: false, userAgent: FIREFOX_UA });
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => (key === 'forceViewTransitions' ? '1' : null),
    });
    const startViewTransition = vi.fn((update: () => void | Promise<void>) => {
      void update();

      return {
        skipTransition: vi.fn(),
        ready: Promise.resolve(),
        finished: Promise.resolve(),
        updateCallbackDone: Promise.resolve(),
      };
    });
    vi.stubGlobal('document', { startViewTransition });
    const cb = vi.fn(async () => undefined);
    const wrapped = wrapWithViewTransition(false, cb);

    await wrapped();

    expect(cb).toHaveBeenCalledOnce();
    expect(startViewTransition).toHaveBeenCalledOnce();
  });

  it('runs the callback directly when transitions are disabled', async () => {
    const startViewTransition = vi.fn();
    vi.stubGlobal('document', { startViewTransition });
    const cb = vi.fn(async () => undefined);
    const wrapped = wrapWithViewTransition(true, cb);

    await wrapped();

    expect(cb).toHaveBeenCalledOnce();
    expect(startViewTransition).not.toHaveBeenCalled();
  });

  it('still navigates when startViewTransition throws before the update', async () => {
    const startViewTransition = vi.fn(() => {
      throw new TypeError('Duplicate view-transition-name value');
    });
    vi.stubGlobal('document', { startViewTransition });
    const cb = vi.fn(async () => undefined);
    const wrapped = wrapWithViewTransition(false, cb);

    await wrapped();

    expect(cb).toHaveBeenCalledOnce();
  });

  it('does not navigate twice when the throw happens after the update started', async () => {
    const startViewTransition = vi.fn((update: () => void | Promise<void>) => {
      void update();
      throw new TypeError('Duplicate view-transition-name value');
    });
    vi.stubGlobal('document', { startViewTransition });
    const cb = vi.fn(async () => undefined);
    const wrapped = wrapWithViewTransition(false, cb);

    await wrapped();

    expect(cb).toHaveBeenCalledOnce();
  });

  it('skips a hung transition so the overlay cannot cover the page', async () => {
    const skipTransition = vi.fn();
    const startViewTransition = vi.fn((update: () => void | Promise<void>) => {
      void update();

      return {
        skipTransition,
        ready: Promise.resolve(),
        finished: new Promise(() => undefined),
        updateCallbackDone: Promise.resolve(),
      };
    });
    vi.stubGlobal('document', { startViewTransition });
    const cb = vi.fn(async () => undefined);
    const wrapped = wrapWithViewTransition(false, cb);

    const done = wrapped();
    await vi.advanceTimersByTimeAsync(1000);
    await done;

    expect(cb).toHaveBeenCalledOnce();
    expect(skipTransition).toHaveBeenCalledOnce();
  });

  it('skips when ready rejects (Firefox duplicate-name / IB-split)', async () => {
    const skipTransition = vi.fn();
    let rejectReady: (reason?: unknown) => void = () => undefined;
    let resolveFinished: () => void = () => undefined;
    const startViewTransition = vi.fn((update: () => void | Promise<void>) => {
      void update();

      return {
        skipTransition: () => {
          skipTransition();
          resolveFinished();
        },
        ready: new Promise<void>((_, reject) => {
          rejectReady = reject;
        }),
        finished: new Promise<void>(resolve => {
          resolveFinished = resolve;
        }),
        updateCallbackDone: Promise.resolve(),
      };
    });
    vi.stubGlobal('document', { startViewTransition });
    const cb = vi.fn(async () => undefined);
    const wrapped = wrapWithViewTransition(false, cb);

    const done = wrapped();
    await vi.waitFor(() => expect(startViewTransition).toHaveBeenCalledOnce());
    rejectReady(new Error('duplicate name'));
    await done;

    expect(cb).toHaveBeenCalledOnce();
    expect(skipTransition).toHaveBeenCalledOnce();
  });
});
