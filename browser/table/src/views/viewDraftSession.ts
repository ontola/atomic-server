import type { TableViewConfiguration } from './configuration.js';

export interface TableViewSource<Value> {
  value: Value;
  revision?: string;
}
export interface TableViewDraft<Value> extends TableViewSource<Value> {
  readonly id: number;
  readonly version: number;
}
export interface TableViewSave<Value> extends TableViewDraft<Value> {
  readonly scope: string;
  readonly operation: number;
}
export interface TableViewDraftSessionState<Value> {
  readonly drafts: ReadonlyMap<string, TableViewDraft<Value>>;
  readonly errors: ReadonlyMap<string, Error>;
  readonly busy: boolean;
  readonly draftCount: number;
}
interface Options<Value> {
  capture?: (value: Value) => Value;
  allowEditsWhileSaving?: boolean;
  concurrentScopes?: boolean;
  /** Merge only edits made after submission onto the confirmed source. Required
   * when edits remain enabled during a save; backend transaction policy stays
   * with the adapter. */
  rebase?: (current: Value, submitted: Value, confirmed: Value) => Value;
}

/** Saved-view working state, scoped by explicit graph/table/view identities.
 * Pristine views read their live source directly. Dirty drafts retain their
 * original revision across incoming changes and navigation. The host performs
 * persistence between begin/finish (or fail) and owns source revision checks,
 * prepared identities, navigation and whether accepted writes are queued. */
export function createTableViewDraftSession<Value = TableViewConfiguration>(
  options: Options<Value> = {},
) {
  if (options.allowEditsWhileSaving && !options.rebase)
    throw Error('Editable in-flight view drafts require a rebase policy.');
  const capture = options.capture ?? structuredClone;
  let nextId = 0;
  let nextVersion = 0;
  let nextOperation = 0;
  const operations = new Map<TableViewSave<Value>, TableViewSave<Value>>();
  const failedSaves = new WeakMap<TableViewSave<Value>, TableViewSave<Value>>();
  let state: TableViewDraftSessionState<Value> = {
    drafts: new Map(),
    errors: new Map(),
    busy: false,
    draftCount: 0,
  };
  const listeners = new Set<() => void>();

  const publish = (drafts = state.drafts, errors = state.errors) => {
    state = {
      drafts,
      errors,
      busy: operations.size > 0,
      draftCount: new Set([...drafts.values()].map(draft => draft.id)).size,
    };
    listeners.forEach(listener => {
      try {
        listener();
      } catch {
        /* Observers cannot change a save result. */
      }
    });
  };

  const matchingKeys = (id: number) =>
    [...state.drafts]
      .filter(([, draft]) => draft.id === id)
      .map(([key]) => key);

  const clearErrors = (keys: string[]) => {
    const errors = new Map(state.errors);
    keys.forEach(key => errors.delete(key));

    return errors;
  };

  const replace = (scope: string, draft: TableViewDraft<Value>) => {
    const drafts = new Map(state.drafts);
    const keys = matchingKeys(draft.id);
    (keys.length ? keys : [scope]).forEach(key => drafts.set(key, draft));
    publish(drafts, clearErrors([...keys, scope]));
  };

  return {
    getSnapshot: () => state,
    subscribe: (listener: () => void) => {
      listeners.add(listener);

      return () => {
        listeners.delete(listener);
      };
    },
    read: (scope: string, source: TableViewSource<Value>) => {
      const draft = state.drafts.get(scope);

      return {
        saving: [...operations.values()].some(
          save => save.scope === scope || save.id === draft?.id,
        ),
        value: draft?.value ?? source.value,
        revision: draft ? draft.revision : source.revision,
        dirty: !!draft,
        conflict:
          !!draft &&
          ![...operations.values()].some(save => save.id === draft.id) &&
          draft.revision !== source.revision,
        error: state.errors.get(scope),
      };
    },
    edit: (
      scope: string,
      source: TableViewSource<Value>,
      change: (value: Value) => Value,
    ) => {
      if (operations.size && !options.allowEditsWhileSaving) return false;
      const previous = state.drafts.get(scope);
      const value = change(capture(previous ? previous.value : source.value));
      replace(scope, {
        id: previous?.id ?? ++nextId,
        version: ++nextVersion,
        value: capture(value),
        revision: previous ? previous.revision : source.revision,
      });

      return true;
    },
    /** Carry an implicit draft to its prepared view before attachment makes that
     * identity visible. Existing target drafts are never overwritten. */
    alias: (scope: string, target: string) => {
      const draft = state.drafts.get(scope);
      if (!draft) return false;
      const existing = state.drafts.get(target);
      if (existing && existing.id !== draft.id)
        throw Error('The target view already has a draft.');
      const drafts = new Map(state.drafts);
      drafts.set(target, draft);
      publish(drafts);

      return true;
    },
    move: (scope: string, target: string) => {
      if (scope === target) return true;
      const draft = state.drafts.get(scope);
      if (!draft) return false;
      const existing = state.drafts.get(target);
      if (existing && existing.id !== draft.id)
        throw Error('The target view already has a draft.');
      const drafts = new Map(state.drafts);
      drafts.set(target, draft);
      drafts.delete(scope);
      const errors = new Map(state.errors);
      const error = errors.get(scope);
      if (error) errors.set(target, error);
      errors.delete(scope);
      publish(drafts, errors);

      return true;
    },
    begin: (
      scope: string,
      source: TableViewSource<Value>,
    ): TableViewSave<Value> | undefined => {
      if (operations.size && !options.concurrentScopes) return undefined;
      let draft = state.drafts.get(scope);
      if (
        [...operations.values()].some(
          save => save.scope === scope || save.id === draft?.id,
        )
      )
        return undefined;

      if (!draft) {
        draft = {
          id: ++nextId,
          version: ++nextVersion,
          value: capture(source.value),
          revision: source.revision,
        };
        const drafts = new Map(state.drafts);
        drafts.set(scope, draft);
        state = { ...state, drafts };
      }

      const active = {
        ...draft,
        value: capture(draft.value),
        scope,
        operation: ++nextOperation,
      };
      const activeToken = Object.freeze({
        ...active,
        value: capture(active.value),
      });
      operations.set(activeToken, active);
      publish(state.drafts, clearErrors(matchingKeys(draft.id)));

      return activeToken;
    },
    finish: (
      save: TableViewSave<Value>,
      confirmed: TableViewSource<Value>,
      targetScope?: string,
    ) => {
      const active = operations.get(save);
      if (!active) return false;
      const keys = matchingKeys(save.id);
      const current = keys.length ? state.drafts.get(keys[0]) : undefined;
      const drafts = new Map(state.drafts);
      keys.forEach(key => drafts.delete(key));

      if (current && current.version !== save.version) {
        const target = targetScope ?? save.scope;
        const existing = drafts.get(target);
        if (existing && existing.id !== save.id)
          throw Error('The target view already has a draft.');
        const value = options.rebase
          ? options.rebase(current.value, active.value, confirmed.value)
          : current.value;
        drafts.set(target, {
          ...current,
          value: capture(value),
          revision: confirmed.revision,
        });
      }

      operations.delete(save);
      publish(
        drafts,
        clearErrors([
          ...keys,
          save.scope,
          ...(targetScope ? [targetScope] : []),
        ]),
      );

      return true;
    },
    fail: (save: TableViewSave<Value>, failure: unknown) => {
      const active = operations.get(save);
      if (!active) return false;
      const errors = new Map(state.errors);
      const error =
        failure instanceof Error ? failure : new Error(String(failure));
      [...matchingKeys(save.id), save.scope].forEach(key =>
        errors.set(key, error),
      );
      failedSaves.set(save, active);
      operations.delete(save);
      publish(state.drafts, errors);

      return true;
    },
    resume: (save: TableViewSave<Value>) => {
      const pending = failedSaves.get(save);
      if (!pending || !matchingKeys(pending.id).length) return false;
      if (operations.size && !options.concurrentScopes) return false;
      if (
        [...operations.values()].some(
          value => value.scope === pending.scope || value.id === pending.id,
        )
      )
        return false;
      failedSaves.delete(save);
      operations.set(save, pending);
      publish(
        state.drafts,
        clearErrors([...matchingKeys(pending.id), pending.scope]),
      );

      return true;
    },
    discard: (scope: string) => {
      const draft = state.drafts.get(scope);
      if (
        [...operations.values()].some(
          save =>
            !options.concurrentScopes ||
            save.scope === scope ||
            save.id === draft?.id,
        )
      )
        return false;
      const keys = draft ? matchingKeys(draft.id) : [scope];
      const drafts = new Map(state.drafts);
      keys.forEach(key => drafts.delete(key));
      publish(drafts, clearErrors(keys));

      return true;
    },
    discardAll: () => {
      if (operations.size) return false;
      publish(new Map(), new Map());

      return true;
    },
    clearError: (scope: string) => {
      publish(state.drafts, clearErrors([scope]));
    },
  };
}
