// @wc-ignore-file
/**
 * The split-pieces exploration is off unless this browser opted in. The demo
 * route (`/app/pieces-demo`, or `?tester` for user tests) turns it on. It
 * exists where the dev routes do: dev builds and VITE_E2E builds such as the
 * e2e image that usertest runs. With it off, tables
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
