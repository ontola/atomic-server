export interface TableDraftCommitState {
  readonly scope: string;
  readonly busy: boolean;
  readonly error?: Error;
}

export type TableDraftCommitResult<T> =
  | { status: 'saved'; value: T }
  | { status: 'failed'; error: Error }
  | { status: 'blocked' | 'stale' };

/** Shared property/schema commit policy. The host owns its working draft and
 * backend transaction. Failed saves retain that draft; only a host-approved `saved`
 * result may close the editor. Invalidating a scope suppresses stale UI actions,
 * not a backend write that is already in flight. `runPrepared` keeps an opaque
 * prepared identity across attachment failures. Hosts must lock that draft once
 * `hasPrepared` is true; backend writes still own idempotence and confirmation. */
export function createTableDraftCommit(scope = '') {
  let generation = 0;
  let state: TableDraftCommitState = { scope, busy: false };
  const listeners = new Set<() => void>();

  const publish = (next: TableDraftCommitState) => {
    state = next;
    listeners.forEach(listener => {
      try {
        listener();
      } catch {
        /* An observer cannot change the backend outcome. */
      }
    });
  };

  const prepared = new WeakMap<object, { value: unknown }>();

  const run = async <T>(
    commit: () => T | Promise<T>,
    valid = true,
  ): Promise<TableDraftCommitResult<T>> => {
    if (state.busy || !valid) return { status: 'blocked' };

    const expected = generation;
    publish({ scope, busy: true });

    try {
      const value = await commit();
      publish({ scope, busy: false });

      return expected === generation
        ? { status: 'saved', value }
        : { status: 'stale' };
    } catch (failure) {
      const error =
        failure instanceof Error ? failure : new Error(String(failure));
      const stale = expected !== generation;
      publish({ scope, busy: false, ...(stale ? {} : { error }) });

      return stale ? { status: 'stale' } : { status: 'failed', error };
    }
  };

  return {
    getSnapshot: () => state,
    subscribe: (listener: () => void) => {
      listeners.add(listener);

      return () => {
        listeners.delete(listener);
      };
    },
    invalidate: () => {
      generation++;
    },
    clearError: () => {
      if (!state.busy && state.error) publish({ scope, busy: false });
    },
    run,
    hasPrepared: (draft: object) => prepared.has(draft),
    runPrepared: <Draft extends object, Prepared, Result>(
      draft: Draft,
      prepare: (draft: Draft) => Prepared | Promise<Prepared>,
      commit: (prepared: Prepared) => Result | Promise<Result>,
      valid = true,
    ) =>
      run(async () => {
        let checkpoint = prepared.get(draft);

        if (!checkpoint) {
          checkpoint = { value: await prepare(draft) };
          prepared.set(draft, checkpoint);
        }

        return commit(checkpoint.value as Prepared);
      }, valid),
  };
}
