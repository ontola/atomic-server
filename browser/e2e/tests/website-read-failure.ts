/** Runs as an init script, before the application publishes its Store. */
export function installWebsiteReadFailure(subject: string) {
  let released = false;
  let failures = 0;
  const control = {
    get failures() {
      return failures;
    },
    release() {
      released = true;
    },
  };
  Object.defineProperty(window, '__atomicWebsiteReadFailure', {
    configurable: true,
    value: control,
  });

  const patch = (store: typeof window.store) => {
    const read = store.getResource.bind(store);
    store.getResource = (async (...args: Parameters<typeof read>) => {
      if (args[0] === subject && !released) {
        failures += 1;
        throw new Error(
          `Async Request for subject "${subject}" timed out after 10000ms.`,
        );
      }

      return read(...args);
    }) as typeof store.getResource;
  };

  if (window.store) {
    patch(window.store);

    return;
  }

  // App.tsx assigns this before mounting React. Hook that assignment rather
  // than polling: even a fast first preview read must see the injected failure.
  Object.defineProperty(window, 'store', {
    configurable: true,
    set(store: typeof window.store) {
      patch(store);
      Object.defineProperty(window, 'store', {
        configurable: true,
        enumerable: true,
        writable: true,
        value: store,
      });
    },
  });
}

export interface WebsiteReadFailureControl {
  readonly failures: number;
  release(): void;
}
