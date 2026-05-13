import type * as Loro from 'loro-crdt';

/**
 * To prevent bloat we don't always want to include Loro in the bundle.
 * Since loro-crdt is an optional dependency (WASM), we load it lazily.
 */
export class LoroLoader {
  private static _Loro: typeof Loro | undefined;
  private static _readyListeners: Set<() => void> = new Set();

  public static get Loro(): typeof Loro {
    if (!this._Loro) {
      throw new Error('Loro not initialized');
    }

    return this._Loro;
  }

  public static async initializeLoro(): Promise<void> {
    if (this._Loro) {
      return;
    }

    // In a browser, import loro-crdt's `web` build and run its
    // wasm-bindgen init. The default `loro-crdt` entry resolves (via
    // its `module` field) to the `bundler` build, whose WASM↔JS
    // circular import + top-level-await glue HANGS under
    // `vite-plugin-wasm` (loro-crdt ≥ 1.12) — `import()` never settles,
    // no error. The `web` build is purpose-built for direct browser
    // use: it fetches `loro_wasm_bg.wasm` and instantiates it via an
    // explicit `default()` init. In Node (tests) the `web` build's
    // `fetch(new URL(...))` can't read a file:// URL, so fall back to
    // the default entry (resolves to the Node build there).
    const isBrowser =
      typeof window !== 'undefined' && typeof window.document !== 'undefined';

    try {
      const mod = isBrowser
        ? ((await import('loro-crdt/web')) as unknown as typeof Loro & {
            default?: unknown;
          })
        : await import('loro-crdt');

      // The `web` build (wasm-bindgen web target) exposes its async
      // init as the default export and instantiates nothing until it
      // runs. The `bundler` / Node builds have no default function and
      // auto-init, so this is a no-op for them.
      const init = (mod as { default?: unknown }).default;

      if (typeof init === 'function') {
        await (init as () => Promise<unknown>)();
      }

      this._Loro = mod;
    } catch (e) {
      console.error(
        '[LoroLoader] initializeLoro: loro-crdt import/init failed:',
        e,
      );
      throw e;
    }

    // Fire the ready callbacks. Hooks that called `getLoroDoc()` *before*
    // the WASM module finished loading would have observed it as
    // `undefined` and cached that result in `useSyncExternalStore`; they
    // need an external nudge to re-evaluate now that the WASM is ready.
    // Without this, opening a doc in a fresh tab leaves the editor
    // stuck on "Loading…" forever — the `store.subscribe(subject, …)`
    // signal that `useLoroDoc` listens to fires only on resource
    // updates, never on WASM-ready.
    const listeners = [...this._readyListeners];
    this._readyListeners.clear();

    for (const cb of listeners) {
      try {
        cb();
      } catch (e) {
        console.warn('[LoroLoader] ready listener threw:', e);
      }
    }
  }

  public static isLoaded(): boolean {
    return this._Loro !== undefined;
  }

  public static loadCheck(): void {
    if (!this.isLoaded()) {
      throw new Error('Loro not initialized. Call enableLoro() first.');
    }
  }

  /**
   * Register a callback that fires once when the Loro WASM module
   * finishes loading. If Loro is already loaded the callback runs
   * synchronously. Returns an unsubscribe function for callers that want
   * to clean up before the load completes (e.g. React unmount during
   * the lazy load). Callbacks fire exactly once.
   */
  public static onReady(cb: () => void): () => void {
    if (this.isLoaded()) {
      cb();

      return () => undefined;
    }

    this._readyListeners.add(cb);

    return () => this._readyListeners.delete(cb);
  }
}

/**
 * Enables the use of Loro CRDT features in the library.
 * Call this somewhere early on in your application and make sure the loro-crdt package is installed.
 */
export const enableLoro = async () => {
  await LoroLoader.initializeLoro();
};
