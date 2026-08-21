import { beforeEach, describe, expect, it } from 'vitest';
import type { CanvasStroke } from '@tomic/lib';
import {
  archiveBranch,
  BRANCH_LIMIT,
  bootstrapUndoSteps,
  loadCanvasHistory,
  saveCanvasHistory,
  scrubIndexFor,
  SCRUB_PIXELS_PER_HISTORY,
  stacksAt,
  strokesEqual,
  timelineOf,
  type StrokeSnapshot,
} from './history-helpers';

/** A distinguishable single-stroke snapshot. */
function snap(n: number): StrokeSnapshot {
  return [{ color: n, width: 1, path: [[n, n]] }];
}

/** Raw strokeData propval as stored on a resource (JSON stroke objects). */
function rawSnap(n: number): CanvasStroke[] {
  return snap(n);
}

describe('timelineOf', () => {
  it('reads undo stack, current, then redo stack oldest-first', () => {
    // redo stack: pop() must return the NEAREST future, so the nearest
    // state sits at the END of the array and the furthest at index 0.
    const timeline = timelineOf(
      { undo: [snap(1), snap(2)], redo: [snap(5), snap(4)] },
      snap(3),
    );

    expect(timeline).toEqual([snap(1), snap(2), snap(3), snap(4), snap(5)]);
  });
});

describe('stacksAt', () => {
  const timeline = [snap(1), snap(2), snap(3), snap(4), snap(5)];

  it('round-trips with timelineOf at every index', () => {
    for (let i = 0; i < timeline.length; i++) {
      const stacks = stacksAt(timeline, i);
      expect(timelineOf(stacks, timeline[i])).toEqual(timeline);
    }
  });

  it('keeps the future redoable after landing in the middle', () => {
    const stacks = stacksAt(timeline, 1);

    expect(stacks.undo).toEqual([snap(1)]);
    // pop() order: nearest future (snap(3)) comes off first.
    expect(stacks.redo[stacks.redo.length - 1]).toEqual(snap(3));
    expect(stacks.redo[0]).toEqual(snap(5));
  });

  it('lands on the tip with an empty redo stack', () => {
    const stacks = stacksAt(timeline, 4);

    expect(stacks.undo).toEqual(timeline.slice(0, 4));
    expect(stacks.redo).toEqual([]);
  });
});

describe('scrubIndexFor', () => {
  it('maps a full-width drag to the whole timeline', () => {
    // Dragging left by the full scrub width from the tip reaches index 0.
    expect(scrubIndexFor(9, -SCRUB_PIXELS_PER_HISTORY, 10)).toBe(0);
  });

  it('moves proportionally to history length', () => {
    // Half the scrub width over 10 states = 5 steps back.
    expect(scrubIndexFor(9, -SCRUB_PIXELS_PER_HISTORY / 2, 10)).toBe(4);
  });

  it('clamps to both ends', () => {
    expect(scrubIndexFor(1, -10_000, 5)).toBe(0);
    expect(scrubIndexFor(1, 10_000, 5)).toBe(4);
  });

  it('scrubs forward with a rightward drag', () => {
    expect(scrubIndexFor(0, SCRUB_PIXELS_PER_HISTORY / 2, 10)).toBe(5);
  });
});

describe('archiveBranch', () => {
  it('appends a cloned snapshot with an id', () => {
    const branches = archiveBranch([], snap(1));

    expect(branches).toHaveLength(1);
    expect(branches[0].id).toBeTruthy();
    expect(branches[0].strokes).toEqual(snap(1));
    expect(branches[0].strokes).not.toBe(snap(1));
  });

  it('skips empty snapshots', () => {
    expect(archiveBranch([], [])).toEqual([]);
  });

  it('skips duplicates of an existing branch', () => {
    const once = archiveBranch([], snap(1));

    expect(archiveBranch(once, snap(1))).toBe(once);
  });

  it('drops the oldest branch beyond the limit', () => {
    let branches = archiveBranch([], snap(0));

    for (let i = 1; i <= BRANCH_LIMIT; i++) {
      branches = archiveBranch(branches, snap(i));
    }

    expect(branches).toHaveLength(BRANCH_LIMIT);
    expect(branches[0].strokes).toEqual(snap(1));
  });
});

describe('bootstrapUndoSteps', () => {
  it('drops states identical to the current strokes', () => {
    const steps = bootstrapUndoSteps([rawSnap(1), rawSnap(2)], snap(2));

    expect(steps).toEqual([snap(1)]);
  });

  it('treats versions without strokeData as the empty state', () => {
    const steps = bootstrapUndoSteps([undefined, rawSnap(1)], snap(1));

    expect(steps).toEqual([[]]);
  });

  it('dedupes consecutive identical states', () => {
    const steps = bootstrapUndoSteps(
      [rawSnap(1), rawSnap(1), rawSnap(2)],
      snap(3),
    );

    expect(steps).toEqual([snap(1), snap(2)]);
  });

  it('survives a mis-ordered history with a trailing strokeless version', () => {
    // getLoroHistory can return [current-state, genesis-without-strokes]
    // for a canvas drawn purely locally. The current state must not
    // become an undo step; the genesis becomes "undo to empty".
    const steps = bootstrapUndoSteps([rawSnap(2), undefined], snap(2));

    expect(steps).toEqual([[]]);
  });
});

describe('strokesEqual', () => {
  it('compares structurally', () => {
    expect(strokesEqual(snap(1), snap(1))).toBe(true);
    expect(strokesEqual(snap(1), snap(2))).toBe(false);
    expect(strokesEqual([], [])).toBe(true);
  });
});

// These tests run in node, which has no localStorage. An in-memory stand-in
// keeps them dependency-free; the helpers only ever use these four.
const storage = new Map<string, string>();
globalThis.localStorage = {
  getItem: (k: string) => storage.get(k) ?? null,
  setItem: (k: string, v: string) => void storage.set(k, v),
  removeItem: (k: string) => void storage.delete(k),
  clear: () => storage.clear(),
} as unknown as Storage;

describe('canvas history persistence', () => {
  const subject = 'https://example.com/canvas-persist';

  beforeEach(() => {
    localStorage.clear();
  });

  /**
   * Reconstructing undo steps from the Loro history is expensive, and it
   * legitimately returns nothing for a canvas with no prior state. Without a
   * recorded attempt, "no steps" is indistinguishable from "never ran", so
   * every open paid for the walk again.
   */
  it('remembers that the bootstrap ran even when it found no steps', () => {
    saveCanvasHistory(subject, {
      undo: [],
      redo: [],
      branches: [],
      bootstrapped: true,
    });

    const stored = loadCanvasHistory(subject);

    expect(stored.bootstrapped).toBe(true);
    expect(stored.undo).toEqual([]);
  });

  it('treats a canvas never seen on this device as un-bootstrapped', () => {
    expect(loadCanvasHistory('https://example.com/canvas-unseen')).toEqual({
      undo: [],
      redo: [],
      branches: [],
      bootstrapped: false,
    });
  });

  it('treats history saved before the flag existed as un-bootstrapped', () => {
    // Entries written by an older build carry undo state but no flag; they
    // must not be read as "already bootstrapped".
    localStorage.setItem(
      `canvas-undo:${subject}`,
      JSON.stringify({ undo: [snap(1)], redo: [], branches: [] }),
    );

    const stored = loadCanvasHistory(subject);

    expect(stored.bootstrapped).toBe(false);
    expect(stored.undo).toEqual([snap(1)]);
  });
});
