import { useSyncExternalStore } from 'react';

export interface TableHistoryState {
  readonly canUndo: boolean;
  readonly busy: boolean;
  readonly depth: number;
}

export interface TableHistoryOptions<Item> {
  /** Capture immutable values; without this the caller owns snapshotting. */
  capture?: (item: Item) => Item;
  /** Merge consecutive single edits, preserving the first pre-edit value. */
  merge?: (previous: Item, next: Item) => Item | undefined;
}

/** Session-local undo. Batches run in reverse order. Successful items are removed
 * immediately; a failure retains only the failed and unattempted items.
 * Backend writes are not made atomic by this stack. No redo or automatic retry. */
export function createTableHistory<Item>(
  options: TableHistoryOptions<Item> = {},
) {
  let entries: { items: readonly Item[]; batch: boolean }[] = [];
  let state: TableHistoryState = { canUndo: false, busy: false, depth: 0 };
  const listeners = new Set<() => void>();

  const publish = (busy = state.busy) => {
    state = { canUndo: entries.length > 0, busy, depth: entries.length };
    for (const listener of listeners) listener();
  };

  const capture = (item: Item) =>
    options.capture ? options.capture(item) : item;

  const assertIdle = () => {
    if (state.busy)
      throw Error('Wait for undo to finish before changing history');
  };

  return {
    getSnapshot: () => state,
    subscribe: (listener: () => void) => {
      listeners.add(listener);

      return () => {
        listeners.delete(listener);
      };
    },
    record(item: Item) {
      assertIdle();
      const next = capture(item);
      const last = entries.at(-1);
      const merged =
        last && !last.batch ? options.merge?.(last.items[0], next) : undefined;
      if (last && merged !== undefined)
        entries = [...entries.slice(0, -1), { items: [merged], batch: false }];
      else entries = [...entries, { items: [next], batch: false }];
      publish();
    },
    recordBatch(items: readonly Item[]) {
      assertIdle();
      if (!items.length) return;
      entries = [...entries, { items: items.map(capture), batch: true }];
      publish();
    },
    clear() {
      assertIdle();
      entries = [];
      publish();
    },
    async undo(apply: (item: Item) => Promise<void>): Promise<void> {
      if (state.busy || !entries.length) return;
      publish(true);

      try {
        let remaining = entries.at(-1)!.items;

        while (remaining.length) {
          await apply(remaining[remaining.length - 1]);
          remaining = remaining.slice(0, -1);
          if (remaining.length)
            entries = [
              ...entries.slice(0, -1),
              { ...entries.at(-1)!, items: remaining },
            ];
          else entries = entries.slice(0, -1);
          publish(true);
        }
      } finally {
        publish(false);
      }
    },
  };
}

export type TableHistory<Item> = ReturnType<typeof createTableHistory<Item>>;

export function useTableHistoryState<Item>(history: TableHistory<Item>) {
  return useSyncExternalStore(
    history.subscribe,
    history.getSnapshot,
    history.getSnapshot,
  );
}
