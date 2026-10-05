// @wc-ignore-file
/**
 * The split-pieces exploration is off unless this browser opted in. The demo
 * route (`/app/pieces-demo`, dev builds only) turns it on. With it off, tables
 * offer apps exactly as before (`appsForClass`).
 */
export const PIECES_FLAG_KEY = 'atomic.experimental.split-pieces';

export function piecesEnabled(): boolean {
  try {
    return globalThis.localStorage?.getItem(PIECES_FLAG_KEY) === 'true';
  } catch {
    return false;
  }
}

export function setPiecesEnabled(enabled: boolean): void {
  try {
    if (enabled) globalThis.localStorage?.setItem(PIECES_FLAG_KEY, 'true');
    else globalThis.localStorage?.removeItem(PIECES_FLAG_KEY);
  } catch {
    // Storage blocked: the flag simply stays off.
  }
}
