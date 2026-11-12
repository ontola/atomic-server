/** One implicit view for one selection epoch. The host creates a fresh
 * initializer when its table/active-view identity changes. Backend creation
 * and attachment policies remain in the callback. */
export function createTableViewInitializer<Handle>(scope: string) {
  let pending: Promise<Handle> | undefined;

  return {
    scope,
    /** Start another explicit intent; this does not cancel an in-flight write. */
    reset: () => {
      pending = undefined;
    },
    ensure(create: () => Promise<Handle>): Promise<Handle> {
      if (!pending) {
        const created = Promise.resolve()
          .then(create)
          .catch(error => {
            if (pending === created) pending = undefined;
            throw error;
          });
        pending = created;
      }

      return pending;
    },
  };
}
