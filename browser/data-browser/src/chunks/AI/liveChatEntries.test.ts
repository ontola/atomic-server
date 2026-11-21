import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Resource, Store } from '@tomic/react';
import type { AtomicUIMessage } from './types';

const queryPages = vi.fn<() => Promise<string[]>>();

vi.mock('@helpers/chatLog', async importOriginal => ({
  ...(await importOriginal<typeof import('@helpers/chatLog')>()),
  queryPages: () => queryPages(),
}));

const { mergeLiveMessages, pagesOf } = await import('./chatConversionUtils');

const msg = (id: string, text: string): AtomicUIMessage => ({
  id,
  role: 'user',
  parts: [{ type: 'text', text }],
});

describe('mergeLiveMessages', () => {
  it('adds messages that are not on screen yet', () => {
    const a = msg('p#1', 'a');
    const b = msg('p#2', 'b');
    const { messages, changed } = mergeLiveMessages([a], [a, b]);
    expect(changed).toBe(true);
    expect(messages).toEqual([a, b]);
  });

  it('returns the same list when nothing changed', () => {
    const current = [msg('p#1', 'a')];
    const result = mergeLiveMessages(current, [msg('p#1', 'a')]);
    expect(result.changed).toBe(false);
    expect(result.messages).toBe(current);
  });

  it('replaces a message from the log that was edited elsewhere', () => {
    const edited = msg('p#1', 'new');
    const { messages } = mergeLiveMessages([msg('p#1', 'old')], [edited]);
    expect(messages[0]).toBe(edited);
  });

  it('keeps a message written here (local id) and does not duplicate it', () => {
    const local = msg('local1', 'hi');
    const remote = msg('p#9', 'from phone');
    const { messages } = mergeLiveMessages(
      [local],
      [msg('p#1', 'hi'), remote],
      m => (m.id === 'local1' ? 'p#1' : m.id),
    );
    expect(messages).toEqual([local, remote]);
    expect(messages[0]).toBe(local);
  });

  it('never drops an in-flight message that is not in the log yet', () => {
    const saved = msg('p#1', 'q');
    const inFlight = msg('local2', 'streaming...');
    const remote = msg('p#2', 'new');
    const { messages } = mergeLiveMessages([saved, inFlight], [saved, remote]);
    expect(messages).toEqual([saved, remote, inFlight]);
  });
});

describe('pagesOf', () => {
  beforeEach(() => queryPages.mockReset());

  const setup = (subject: string) => ({
    store: { normalizeSubject: (s: string) => s } as unknown as Store,
    chat: { subject, new: false, get: () => undefined } as unknown as Resource,
  });

  it('asks again after an empty answer, and stops once pages are found', async () => {
    const { store, chat } = setup('did:ad:liveChat1');
    queryPages.mockResolvedValueOnce([]).mockResolvedValueOnce(['did:ad:pg']);

    expect(await pagesOf(chat, store)).toEqual([]);
    expect(await pagesOf(chat, store)).toEqual(['did:ad:pg']);
    expect(await pagesOf(chat, store)).toEqual(['did:ad:pg']);
    expect(queryPages).toHaveBeenCalledTimes(2);
  });

  it('asks again when told to refresh', async () => {
    const { store, chat } = setup('did:ad:liveChat2');
    queryPages.mockResolvedValue(['did:ad:pg1']);

    await pagesOf(chat, store);
    await pagesOf(chat, store);
    expect(queryPages).toHaveBeenCalledTimes(1);
    await pagesOf(chat, store, { refresh: true });
    expect(queryPages).toHaveBeenCalledTimes(2);
  });
});
