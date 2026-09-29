/**
 * Module-level overlay switch. Lives outside OverlayContainer so action
 * definitions can open search / shortcuts without importing the React tree
 * (that would cycle: OverlayContainer → catalog → appActions → Overlay).
 */

export type OverlayType = 'search' | 'shortcuts' | null;

const overlayListeners = new Set<(overlay: OverlayType) => void>();

let pendingSearchQuery = '';
let pendingSearchScope: string | undefined;

export function setOverlay(overlay: OverlayType): void {
  if (overlay !== 'search') {
    pendingSearchQuery = '';
    pendingSearchScope = undefined;
  }

  overlayListeners.forEach(listener => listener(overlay));
}

/**
 * Opens the search overlay, optionally with `query` already typed in, and
 * optionally limited to what lives under `scope` ("Search children").
 */
export function openSearchOverlay(query?: string, scope?: string): void {
  pendingSearchQuery = query ?? '';
  pendingSearchScope = scope;
  setOverlay('search');
}

/** The resource the search overlay was opened scoped to, if any. */
export function pendingSearchOverlayScope(): string | undefined {
  return pendingSearchScope;
}

/**
 * The query the search overlay starts with. Read on mount, and reset whenever
 * the overlay closes, so a later plain open starts empty again. Not cleared on
 * read: StrictMode calls state initialisers twice.
 */
export function pendingSearchOverlayQuery(): string {
  return pendingSearchQuery;
}

export function openShortcutsOverlay(): void {
  setOverlay('shortcuts');
}

export function closeOverlay(): void {
  setOverlay(null);
}

export function subscribeOverlay(
  listener: (overlay: OverlayType) => void,
): () => void {
  overlayListeners.add(listener);

  return () => {
    overlayListeners.delete(listener);
  };
}
