export interface TableViewWriteState {
  readonly scope: string;
  readonly busy: boolean;
  readonly pending: number;
  readonly error?: Error;
}

/** Serializes a table's metadata writes, including across tab switches. A failed
 * operation stays at the head until explicit Retry; later edits retain their
 * captured payload and cannot turn a failed save into an implicit retry.
 * The adapter owns transactions and idempotent persistence of the same intent. */
export function createTableViewWriteQueue(scope: string) {
  const writes: (() => Promise<void>)[] = [];
  const listeners = new Set<() => void>();
  let state: TableViewWriteState = { scope, busy: false, pending: 0 };
  let running: Promise<void> | undefined;

  const publish = (busy: boolean, error?: Error) => {
    state = {
      scope,
      busy,
      pending: writes.length,
      ...(error ? { error } : {}),
    };
    listeners.forEach(listener => {
      try {
        listener();
      } catch {
        /* Observers cannot change a save outcome. */
      }
    });
  };

  const drain = (): Promise<void> => {
    if (running) return running;
    if (state.error || !writes.length) return Promise.resolve();
    // Defer execution until `running` is assigned, including synchronous errors.
    running = Promise.resolve()
      .then(async () => {
        while (writes.length) {
          try {
            await writes[0]();
            writes.shift();
            publish(true);
          } catch (failure) {
            publish(
              false,
              failure instanceof Error ? failure : new Error(String(failure)),
            );

            return;
          }
        }

        publish(false);
      })
      .then(() => {
        running = undefined;

        return drain();
      });
    publish(true);

    return running;
  };

  return {
    getSnapshot: () => state,
    subscribe: (listener: () => void) => {
      listeners.add(listener);

      return () => {
        listeners.delete(listener);
      };
    },
    enqueue: (write: () => Promise<void>) => {
      writes.push(write);
      publish(state.busy, state.error);

      return drain();
    },
    retry: () => {
      if (!state.busy) publish(false);

      return drain();
    },
  };
}
