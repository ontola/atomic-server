/**
 * Module-level overlay switch. Lives outside OverlayContainer so action
 * definitions can open search / shortcuts without importing the React tree
 * (that would cycle: OverlayContainer → catalog → appActions → Overlay).
 */

export type OverlayType = 'search' | 'shortcuts' | null;

const overlayListeners = new Set<(overlay: OverlayType) => void>();

export function setOverlay(overlay: OverlayType): void {
  overlayListeners.forEach(listener => listener(overlay));
}

export function openSearchOverlay(_query?: string): void {
  setOverlay('search');
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
