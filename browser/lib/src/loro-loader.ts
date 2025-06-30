import type * as Loro from 'loro-crdt';

/**
 * To prevent bloat we don't always want to include Loro in the bundle.
 * Since loro-crdt is an optional dependency (WASM), we load it lazily.
 */
export class LoroLoader {
  private static _Loro: typeof Loro | undefined;

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

    this._Loro = await import('loro-crdt');
  }

  public static isLoaded(): boolean {
    return this._Loro !== undefined;
  }

  public static loadCheck(): void {
    if (!this.isLoaded()) {
      throw new Error('Loro not initialized. Call enableLoro() first.');
    }
  }
}

/**
 * Enables the use of Loro CRDT features in the library.
 * Call this somewhere early on in your application and make sure the loro-crdt package is installed.
 */
export const enableLoro = async () => {
  await LoroLoader.initializeLoro();
};
