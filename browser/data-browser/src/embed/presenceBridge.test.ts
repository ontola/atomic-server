// @wc-ignore-file
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PresenceItem, Store } from '@tomic/lib';
import {
  createPresenceBridge,
  relayLocalPresence,
  setHostFollow,
} from './presenceBridge';

const drive = 'did:ad:drive';
const item = (
  sessionId: string,
  extra: Partial<PresenceItem> = {},
): PresenceItem => ({
  sessionId,
  agent: `did:ad:agent:${sessionId}`,
  resource: 'did:ad:doc',
  updatedAt: 10,
  ...extra,
});

afterEach(() => {
  vi.useRealTimers();
  setHostFollow(null);
});

describe('feeding the app’s list', () => {
  // The real manager needs Loro's wasm (covered in @tomic/lib's presence
  // tests); here it is a map that behaves like inject/remove.
  const setup = () => {
    const entries = new Map<string, Omit<PresenceItem, 'sessionId'>>();
    const manager = {
      injectEntry: vi.fn((id: string, entry: PresenceItem) => {
        entries.set(id, entry);
      }),
      removeEntry: vi.fn((id: string) => {
        entries.delete(id);
      }),
    };
    const store = { getPresence: () => manager } as unknown as Store;

    return { entries, manager, bridge: createPresenceBridge(store) };
  };

  it('shows the app’s sessions with their cursor data and typing', () => {
    const { entries, bridge } = setup();

    bridge.feed(drive, [
      item('a', { data: { cell: 'b2' }, typing: 'did:ad:room', session: 'm' }),
      item('b', { allowFollow: false }),
    ]);

    expect([...entries.keys()]).toEqual(['a', 'b']);
    expect(entries.get('a')).toEqual({
      agent: 'did:ad:agent:a',
      resource: 'did:ad:doc',
      data: { cell: 'b2' },
      typing: 'did:ad:room',
      session: 'm',
      updatedAt: 10,
    });
    expect(entries.get('b')?.allowFollow).toBe(false);
    bridge.dispose();
  });

  it('drops sessions the app no longer lists', () => {
    const { entries, bridge } = setup();

    bridge.feed(drive, [item('a'), item('b')]);
    bridge.feed(drive, [item('b')]);
    expect([...entries.keys()]).toEqual(['b']);

    bridge.feed(drive, []);
    expect(entries.size).toBe(0);
    bridge.dispose();
  });

  it('refreshes quiet entries before they time out, until disposed', () => {
    vi.useFakeTimers();

    const { manager, bridge } = setup();

    bridge.feed(drive, [item('a')]);
    expect(manager.injectEntry).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(8_000);
    expect(manager.injectEntry).toHaveBeenCalledTimes(2);

    bridge.dispose();
    vi.advanceTimersByTime(30_000);
    expect(manager.injectEntry).toHaveBeenCalledTimes(2);
    expect(manager.removeEntry).toHaveBeenCalledWith('a');
  });

  it('ignores entries without a session or agent', () => {
    const { entries, bridge } = setup();

    bridge.feed(drive, [item(''), { ...item('x'), agent: '' }]);
    expect(entries.size).toBe(0);
    bridge.dispose();
  });
});

describe('relaying the page’s own entry', () => {
  const fakeStore = () => {
    let listener: ((d: string, e: unknown) => void) | undefined;
    const store = {
      onLocalPresence: (cb: typeof listener) => {
        listener = cb;

        return () => {
          listener = undefined;
        };
      },
    } as unknown as Store;

    return { store, write: (e: unknown) => listener?.(drive, e) };
  };

  it('sends data, typing and session, never resource or following', () => {
    vi.useFakeTimers();

    const { store, write } = fakeStore();
    const send = vi.fn();

    relayLocalPresence(store, send);
    write({
      agent: 'x',
      resource: 'did:ad:doc',
      following: 'did:ad:agent:l',
      data: { row: 1 },
      typing: 'did:ad:room',
      session: 'did:ad:meeting',
    });

    expect(send).toHaveBeenCalledWith({
      data: { row: 1 },
      typing: 'did:ad:room',
      session: 'did:ad:meeting',
    });
  });

  it('says nothing for writes that change none of them, and clears with nulls', () => {
    vi.useFakeTimers();

    const { store, write } = fakeStore();
    const send = vi.fn();

    relayLocalPresence(store, send);
    write({ agent: 'x', resource: 'did:ad:doc' });
    expect(send).not.toHaveBeenCalled();

    write({ agent: 'x', typing: 'room' });
    vi.advanceTimersByTime(500);
    write({ agent: 'x', typing: 'room', resource: 'other' });
    vi.advanceTimersByTime(500);
    expect(send).toHaveBeenCalledTimes(1);

    write(undefined);
    expect(send).toHaveBeenLastCalledWith({
      data: null,
      typing: null,
      session: null,
    });
  });

  it('keeps cursor storms to the last value per interval', () => {
    vi.useFakeTimers();

    const { store, write } = fakeStore();
    const send = vi.fn();

    relayLocalPresence(store, send);

    for (let i = 0; i < 20; i++) write({ agent: 'x', data: { x: i } });

    expect(send).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(200);
    expect(send).toHaveBeenCalledTimes(2);
    expect(send).toHaveBeenLastCalledWith(
      expect.objectContaining({ data: { x: 19 } }),
    );
  });

  it('stops when told to', () => {
    const { store, write } = fakeStore();
    const send = vi.fn();

    relayLocalPresence(store, send)();
    write({ agent: 'x', typing: 'room' });
    expect(send).not.toHaveBeenCalled();
  });
});
