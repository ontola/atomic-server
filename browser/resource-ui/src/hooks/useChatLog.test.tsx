// @vitest-environment jsdom
import { useLayoutEffect } from 'react';
import { renderHook } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { toEntryId } from '../helpers/chatLog.js';
import { useChatLogEntry } from './useChatLog.js';

const fixture = vi.hoisted(() => {
  const state = { counter: 0, text: 'first' };
  const doc = { frontiers: () => [{ peer: '1', counter: state.counter }] };
  const resource = {
    getLoroDoc: () => doc,
    getChatLogEntry: () => ({ t: state.text }),
    on: () => () => {},
  };
  const store = {
    subscribe: () => () => {},
    getResourceLoading: () => resource,
  };

  return { state, store };
});
vi.mock('@tomic/react', async original => ({
  ...(await original<typeof import('@tomic/react')>()),
  useStore: () => fixture.store,
}));

it('shows an entry imported between reading its page and subscribing', () => {
  const id = toEntryId('atomic:page', 'abc-12345678');
  const { result } = renderHook(() => {
    const { entry } = useChatLogEntry(id);
    useLayoutEffect(() => {
      fixture.state.text = 'imported';
      fixture.state.counter++;
    }, []);

    return entry?.t;
  });
  expect(result.current).toBe('imported');
});
