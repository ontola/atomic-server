export type AtomicWasmModule = {
  default: (init?: {
    module_or_path: string | WebAssembly.Module;
  }) => Promise<unknown>;
  /** `values` is `{ [propertySubject]: number | string | boolean | null }`. */
  evaluateFormula: (
    expression: unknown,
    values: unknown,
    nowMs: number,
    /** Minutes east of UTC; a DATE is midnight in this zone. */
    tzOffsetMinutes: number,
  ) => number | null;
  validateFormula: (expression: unknown) => string | null;
  argon2idDeriveKey: (
    secret: string,
    salt: Uint8Array,
    memKib: number,
    iterations: number,
    parallelism: number,
  ) => Uint8Array;
};

/** What the dynamic import actually gives us: an older build of the glue has
 * `default` but not the exports added later, which is what {@link loadAtomicWasm}
 * checks. */
type LoadedWasmModule = Partial<AtomicWasmModule> &
  Pick<AtomicWasmModule, 'default'>;

let wasmModulePromise: Promise<AtomicWasmModule> | null = null;

/**
 * Lazily loads the atomic_wasm bundle on the main thread, independent of the
 * ClientDb worker (initClientDb.ts) — its stateless exports (the KDF, formula
 * evaluation) are not a database, so it doesn't need OPFS or worker/leader-election machinery.
 *
 * The export is verified rather than assumed. A page that spans a deploy can
 * hold a module from an older build (see `helpers/wasmUrls.ts`), where calling
 * the missing KDF surfaces as a bare "is not a function" TypeError halfway
 * through generating a recovery code. Failing here instead says what to do.
 */
export async function loadAtomicWasm(source: {
  jsUrl: () => string;
  wasmSource: () => Promise<WebAssembly.Module | string>;
}): Promise<AtomicWasmModule> {
  if (!wasmModulePromise) {
    wasmModulePromise = (async () => {
      try {
        const url = source.jsUrl();
        const loaded = (await import(
          /* @vite-ignore */ url
        )) as LoadedWasmModule;
        await loaded.default({ module_or_path: await source.wasmSource() });

        if (typeof loaded.argon2idDeriveKey !== 'function') {
          throw new Error(
            'This page is running an outdated version of Atomic. Reload the page and try again.',
          );
        }

        return loaded as AtomicWasmModule;
      } catch (e) {
        // Never memoize a failure: after the reload this asks for, and for an
        // offline blip on the way to a 6MB binary, a retry must be able to
        // load it rather than replay the rejection for the tab's lifetime.
        wasmModulePromise = null;
        throw e;
      }
    })();
  }

  return wasmModulePromise;
}
