import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  askAssistant,
  hasActionsHost,
  hostFollow,
  hostMeetingEnded,
  hostMeetingStarted,
  joinCall,
  leaveCall,
  hostUnfollow,
  reportPresence,
  openNative,
  reportShown,
  reportSidebarIcons,
  SHOW_SIDEBAR_ICONS_KEY,
  reportTheme,
  setActionsHost,
  SHOWN_DELAY_MS,
} from './hostActions';

afterEach(() => setActionsHost(undefined));

it('is false without an app', async () => {
  expect(
    await openNative('https://atomicdata.dev/classes/ChatRoom', 'did:ad:room'),
  ).toBe(false);
});

it('asks the app and reports its answer', async () => {
  const call = vi.fn().mockResolvedValue(true);

  setActionsHost({ call });
  expect(
    await openNative(
      'https://atomicdata.dev/classes/ChatRoom',
      'did:ad:room',
      'Standup',
    ),
  ).toBe(true);
  expect(call).toHaveBeenCalledWith('openNative', [
    'https://atomicdata.dev/classes/ChatRoom',
    'did:ad:room',
    'Standup',
  ]);
});

it('is false when the app declines or does not know the call', async () => {
  setActionsHost({ call: vi.fn().mockResolvedValue(false) });
  expect(
    await openNative('https://atomicdata.dev/classes/ChatRoom', 'did:ad:room'),
  ).toBe(false);

  setActionsHost({ call: vi.fn().mockRejectedValue(new Error('unknown')) });
  expect(
    await openNative('https://atomicdata.dev/classes/ChatRoom', 'did:ad:room'),
  ).toBe(false);
});

describe('askAssistant', () => {
  it('is false without an app', async () => {
    expect(await askAssistant('Fix it', 'did:ad:app')).toBe(false);
  });

  it('asks the app and reports its answer', async () => {
    const call = vi.fn().mockResolvedValue(true);

    setActionsHost({ call });
    expect(await askAssistant('Fix it', 'did:ad:app')).toBe(true);
    expect(call).toHaveBeenCalledWith('askAssistant', ['Fix it', 'did:ad:app']);
  });

  it('is false when the app declines or does not know the call', async () => {
    setActionsHost({ call: vi.fn().mockResolvedValue(false) });
    expect(await askAssistant('Fix it', 'did:ad:app')).toBe(false);

    setActionsHost({ call: vi.fn().mockRejectedValue(new Error('unknown')) });
    expect(await askAssistant('Fix it', 'did:ad:app')).toBe(false);
  });
});

describe('reportShown', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('reports a resource the page stays on, once', () => {
    const call = vi.fn().mockResolvedValue(null);

    setActionsHost({ call });
    reportShown('did:ad:folder');
    vi.advanceTimersByTime(SHOWN_DELAY_MS - 1);
    expect(call).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(call).toHaveBeenCalledWith('opened', ['did:ad:folder']);

    reportShown('did:ad:folder');
    vi.advanceTimersByTime(SHOWN_DELAY_MS);
    expect(call).toHaveBeenCalledTimes(1);
  });

  it('skips a resource passed through, and a page without one', () => {
    const call = vi.fn().mockResolvedValue(null);

    setActionsHost({ call });
    reportShown('did:ad:a');
    vi.advanceTimersByTime(SHOWN_DELAY_MS / 2);
    reportShown('did:ad:b');
    vi.advanceTimersByTime(SHOWN_DELAY_MS);
    expect(call.mock.calls).toEqual([['opened', ['did:ad:b']]]);

    reportShown('did:ad:c');
    reportShown(undefined);
    vi.advanceTimersByTime(SHOWN_DELAY_MS);
    expect(call).toHaveBeenCalledTimes(1);
  });

  it('does nothing without an app, or when the app does not know the call', async () => {
    reportShown('did:ad:a');
    vi.advanceTimersByTime(SHOWN_DELAY_MS);

    setActionsHost({ call: vi.fn().mockRejectedValue(new Error('unknown')) });
    reportShown('did:ad:a');
    vi.advanceTimersByTime(SHOWN_DELAY_MS);
    await vi.runAllTimersAsync();
  });
});

it('tells the app the theme chosen on the page', () => {
  const call = vi.fn().mockResolvedValue(true);

  reportTheme('dark');
  setActionsHost({ call });
  reportTheme('light');
  reportTheme('auto');
  expect(call.mock.calls).toEqual([
    ['theme', ['light']],
    ['theme', ['auto']],
  ]);
});

it('reports the sidebar icons choice to the app, which may not know the call', () => {
  const call = vi.fn().mockResolvedValue(true);

  setActionsHost({ call });
  reportSidebarIcons(false);
  expect(call).toHaveBeenCalledWith('sidebarIcons', [false]);

  setActionsHost({ call: vi.fn().mockRejectedValue(new Error('unknown')) });
  expect(() => reportSidebarIcons(true)).not.toThrow();
  expect(SHOW_SIDEBAR_ICONS_KEY).toBe('showSidebarIcons');
});

it('hands the app the presence fields, follow and unfollow', () => {
  const call = vi.fn().mockResolvedValue(true);

  setActionsHost({ call });
  reportPresence({ data: { x: 1 }, typing: null, session: 'did:ad:meeting' });
  hostFollow('did:ad:agent:a');
  hostUnfollow();

  expect(call.mock.calls).toEqual([
    ['presence', [{ data: { x: 1 }, typing: null, session: 'did:ad:meeting' }]],
    ['follow', ['did:ad:agent:a']],
    ['unfollow', []],
  ]);
});

it('tells the app a meeting started and ended, and not knowing the call is fine', () => {
  const call = vi.fn().mockResolvedValue(true);

  setActionsHost({ call });
  hostMeetingStarted('did:ad:meeting');
  hostMeetingEnded('did:ad:meeting');
  expect(call.mock.calls).toEqual([
    ['meetingStarted', ['did:ad:meeting']],
    ['meetingEnded', ['did:ad:meeting']],
  ]);

  setActionsHost({ call: vi.fn().mockRejectedValue(new Error('unknown')) });
  expect(() => hostMeetingStarted('m')).not.toThrow();
  setActionsHost(undefined);
  expect(() => hostMeetingEnded('m')).not.toThrow();
});

it('does nothing for presence and follow without an app, or when it declines', () => {
  reportPresence({ data: null, typing: null, session: null });
  hostFollow('a');
  hostUnfollow();

  setActionsHost({ call: vi.fn().mockRejectedValue(new Error('unknown')) });
  expect(() => hostFollow('a')).not.toThrow();
});

describe('calls', () => {
  it('joinCall asks the app and reports its answer', async () => {
    const call = vi.fn().mockResolvedValue(true);

    setActionsHost({ call });
    expect(await joinCall('did:ad:meeting')).toBe(true);
    expect(call).toHaveBeenCalledWith('joinCall', ['did:ad:meeting']);
  });

  it('joinCall is false without an app, when it declines or does not know the call', async () => {
    expect(await joinCall('did:ad:meeting')).toBe(false);
    expect(hasActionsHost()).toBe(false);

    setActionsHost({ call: vi.fn().mockResolvedValue(false) });
    expect(hasActionsHost()).toBe(true);
    expect(await joinCall('did:ad:meeting')).toBe(false);

    setActionsHost({ call: vi.fn().mockRejectedValue(new Error('unknown')) });
    expect(await joinCall('did:ad:meeting')).toBe(false);
  });

  it('leaveCall tells the app', () => {
    const call = vi.fn().mockResolvedValue(null);

    setActionsHost({ call });
    leaveCall();
    expect(call).toHaveBeenCalledWith('leaveCall', []);
  });
});
