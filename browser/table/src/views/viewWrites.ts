export interface TableViewWriteContext {
  /** Keep a successful preparation/phase result across retries of this intent.
   * Keys must identify one result type and one immutable input within the job.
   * Failed preparations clear their own checkpoint; accepted writes are not
   * rolled back. Never use this to cache permission/ownership preflights. */
  checkpoint<T>(key: string, prepare: () => Promise<T>): Promise<T>;
}

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
  const writes: {
    run: (context: TableViewWriteContext) => Promise<void>;
    context: TableViewWriteContext;
  }[] = [];
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
            await writes[0].run(writes[0].context);
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
    enqueue: (write: (context: TableViewWriteContext) => Promise<void>) => {
      const checkpoints = new Map<string, Promise<unknown>>();
      const context: TableViewWriteContext = {
        checkpoint<T>(key: string, prepare: () => Promise<T>): Promise<T> {
          let value = checkpoints.get(key);

          if (!value) {
            const pending = Promise.resolve()
              .then(prepare)
              .catch(error => {
                if (checkpoints.get(key) === pending) checkpoints.delete(key);
                throw error;
              });
            value = pending;
            checkpoints.set(key, pending);
          }

          return value as Promise<T>;
        },
      };
      writes.push({ run: write, context });
      publish(state.busy, state.error);

      return drain();
    },
    retry: () => {
      if (!state.busy) publish(false);

      return drain();
    },
  };
}

/** A page's queues survive table navigation while failed/pending operations need
 * an explicit retry. Releasing a pristine queue does not retain an idle cache. */
export function createTableViewWriteQueues() {
  const queues = new Map<
    string,
    ReturnType<typeof createTableViewWriteQueue>
  >();

  return {
    get(scope: string) {
      let queue = queues.get(scope);

      if (!queue) {
        queue = createTableViewWriteQueue(scope);
        queues.set(scope, queue);
      }

      return queue;
    },
    release(scope: string) {
      const state = queues.get(scope)?.getSnapshot();
      if (state && !state.busy && !state.pending) queues.delete(scope);
    },
  };
}
