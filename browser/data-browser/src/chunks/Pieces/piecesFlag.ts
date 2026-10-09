// @wc-ignore-file
import { allowLensEndpointKeysInRenders } from '@tomic/lib';

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

/**
 * While the flag is on, an App's `renders` may hold lens endpoint keys
 * (`record:…`, `rdf:…`), so an integration can declare the provider-shaped
 * endpoint a catalog lens reaches. The keys are provisional until the
 * produced-class declaration exists (atomic-plugins #409, `x-produces`;
 * pieces.md I1, O8). Called once at startup; the flag is read on every
 * validation, so switching it needs no reload.
 */
export function registerPiecesValidation(): void {
  allowLensEndpointKeysInRenders(piecesEnabled);
}
