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

export interface TableViewWriteReceiptState {
  readonly status: 'pending' | 'saved' | 'failed' | 'abandoned';
  readonly error?: Error;
}
export interface TableViewWriteReceipt {
  getSnapshot: () => TableViewWriteReceiptState;
  /** Observe this operation without implicitly retrying any failed write. */
  wait: () => Promise<void>;
  /** Retry this operation only; an earlier failed operation stays blocked. */
  retry: () => Promise<void>;
  /** Discard only an unstarted write or one the adapter proves has not mutated storage. */
  abandon: () => boolean;
}

/** Serializes a table's metadata writes, including across tab switches. A failed
 * operation stays at the head until explicit Retry; later edits retain their
 * captured payload and cannot turn a failed save into an implicit retry.
 * The adapter owns transactions and idempotent persistence of the same intent. */
export function createTableViewWriteQueue(scope: string) {
  const writes: {
    run: (context: TableViewWriteContext) => Promise<void>;
    context: TableViewWriteContext;
    state: TableViewWriteReceiptState;
    started: boolean;
    executing: boolean;
    canAbandon?: () => boolean;
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
          const job = writes[0];
          job.state = { status: 'pending' };
          job.started = true;
          job.executing = true;

          try {
            await job.run(job.context);
            job.state = { status: 'saved' };
            writes.shift();
            publish(true);
          } catch (failure) {
            const error =
              failure instanceof Error ? failure : new Error(String(failure));
            job.state = { status: 'failed', error };
            publish(false, error);

            return;
          } finally {
            job.executing = false;
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

  type Job = (typeof writes)[number];

  const append = (
    write: (context: TableViewWriteContext) => Promise<void>,
    options?: { canAbandon?: () => boolean },
  ): Job => {
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
    const job: Job = {
      run: write,
      context,
      state: { status: 'pending' },
      started: false,
      executing: false,
      canAbandon: options?.canAbandon,
    };
    writes.push(job);
    publish(state.busy, state.error);

    return job;
  };

  const wait = (job: Job): Promise<void> =>
    new Promise((resolve, reject) => {
      const check = () => {
        if (job.state.status === 'saved') {
          listeners.delete(check);
          resolve();
        } else if (job.state.status === 'failed') {
          listeners.delete(check);
          reject(job.state.error);
        } else if (job.state.status === 'abandoned') {
          listeners.delete(check);
          reject(new Error('This view change was abandoned.'));
        } else if (state.error) {
          listeners.delete(check);
          reject(new Error('An earlier view save must be retried first.'));
        }
      };

      listeners.add(check);
      check();
      void drain();
    });

  return {
    getSnapshot: () => state,
    subscribe: (listener: () => void) => {
      listeners.add(listener);

      return () => {
        listeners.delete(listener);
      };
    },
    enqueue: (write: (context: TableViewWriteContext) => Promise<void>) => {
      append(write);

      return drain();
    },
    enqueueTracked: (
      write: (context: TableViewWriteContext) => Promise<void>,
      options?: { canAbandon?: () => boolean },
    ): TableViewWriteReceipt => {
      const job = append(write, options);
      void drain();

      return {
        getSnapshot: () => job.state,
        abandon: () => {
          if (
            job.executing ||
            job.state.status === 'saved' ||
            job.state.status === 'abandoned'
          )
            return false;
          let safe = !job.started;

          if (!safe) {
            try {
              safe = !!job.canAbandon?.();
            } catch {
              return false;
            }
          }

          const index = writes.indexOf(job);
          if (!safe || index < 0) return false;
          writes.splice(index, 1);
          job.state = { status: 'abandoned' };
          publish(state.busy, index === 0 ? undefined : state.error);
          void drain();

          return true;
        },
        wait: () => wait(job),
        retry: () => {
          if (
            job.state.status === 'failed' &&
            writes[0] === job &&
            !state.busy
          ) {
            job.state = { status: 'pending' };
            publish(false);
          }

          return wait(job);
        },
      };
    },
    retry: () => {
      if (!state.busy) {
        if (writes[0]?.state.status === 'failed')
          writes[0].state = { status: 'pending' };
        publish(false);
      }

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
