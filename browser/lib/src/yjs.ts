import type * as Y from 'yjs';

/**
 * To prevent bloat we don't always want to include Yjs in the bundle.
 * Since Yjs is an optional dependency, we need to load it lazily and it might not even be installed.
 */
export class YLoader {
  private static _Y: typeof Y | undefined;

  public static get Y(): typeof Y {
    if (!this._Y) {
      throw new Error('Y not initialized');
    }

    return this._Y;
  }

  public static async initializeY(): Promise<void> {
    if (this._Y) {
      return;
    }

    this._Y = await import('yjs');
  }

  public static isLoaded(): boolean {
    return this._Y !== undefined;
  }

  public static loadCheck(): void {
    if (!this.isLoaded()) {
      throw new Error('Yjs not initialized');
    }
  }
}

/**
 * Enables the use of Yjs features in the library.
 * Call this somewhere early on in your application and make sure the yjs package is installed.
 */
export const enableYjs = async () => {
  await YLoader.initializeY();
};
