import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Store } from '@tomic/react';
import {
  SORT_SUBJECT_FETCH_DEADLINE_MS,
  sortSubjectList,
} from './sortSubjectList';

type Behaviour = string | 'reject' | 'hang' | 'error';

function fakeStore(behaviours: Record<string, Behaviour>): Store {
  return {
    getResource: (subject: string) => {
      const b = behaviours[subject];

      if (b === 'reject') return Promise.reject(new Error('CORS'));
      if (b === 'hang') return new Promise(() => undefined);
      if (b === 'error')
        return Promise.resolve({ subject, title: subject, error: new Error() });

      return Promise.resolve({ subject, title: b });
    },
  } as unknown as Store;
}

describe('sortSubjectList', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('sorts resolved subjects by title', async () => {
    const store = fakeStore({ a: 'Zebra', b: 'Apple', c: 'Mango' });

    expect(await sortSubjectList(store, ['a', 'b', 'c'])).toEqual([
      'b',
      'c',
      'a',
    ]);
  });

  it('keeps failing subjects after resolved ones, ordered by subject', async () => {
    const store = fakeStore({
      'https://x/z': 'reject',
      'https://x/a': 'error',
      ok: 'Title',
    });

    const result = await sortSubjectList(store, [
      'https://x/z',
      'ok',
      'https://x/a',
    ]);

    expect(result).toEqual(['ok', 'https://x/a', 'https://x/z']);
  });

  it('does not wait longer than the deadline for hanging subjects', async () => {
    const store = fakeStore({
      slow1: 'hang',
      slow2: 'hang',
      slow3: 'hang',
      fast: 'Fast',
    });

    let done = false;
    const promise = sortSubjectList(store, [
      'slow3',
      'slow1',
      'fast',
      'slow2',
    ]).then(r => {
      done = true;

      return r;
    });

    await vi.advanceTimersByTimeAsync(SORT_SUBJECT_FETCH_DEADLINE_MS - 1);
    expect(done).toBe(false);

    // Parallel: one deadline in total, not one per subject.
    await vi.advanceTimersByTimeAsync(1);
    const result = await promise;

    expect(done).toBe(true);
    expect(result).toEqual(['fast', 'slow1', 'slow2', 'slow3']);
  });

  it('is deterministic and drops nothing', async () => {
    const behaviours: Record<string, Behaviour> = {
      b: 'reject',
      a: 'hang',
      c: 'T',
      d: 'T',
    };
    const input = ['d', 'b', 'a', 'c'];

    const first = sortSubjectList(fakeStore(behaviours), input);
    const second = sortSubjectList(fakeStore(behaviours), [...input].reverse());

    await vi.advanceTimersByTimeAsync(SORT_SUBJECT_FETCH_DEADLINE_MS);

    const [r1, r2] = await Promise.all([first, second]);

    expect(r1).toEqual(['c', 'd', 'a', 'b']);
    expect(r2).toEqual(r1);
    expect([...r1].sort()).toEqual([...input].sort());
  });
});
