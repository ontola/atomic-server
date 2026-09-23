import { useEffect } from 'react';
import { useLocalStorage } from './useLocalStorage';

const NEW_ACTION_DISCOVERED_KEY = 'atomic.newActionDiscovered';

/**
 * Whether this browser has ever opened the New page. Until it has, the
 * sidebar's "New" button stands out, because it's the doorway to everything
 * you can build (apps, websites, tables, templates) and at rest it's a faint
 * grey line at the bottom of the tree.
 */
export function useNewActionDiscovered() {
  return useLocalStorage(NEW_ACTION_DISCOVERED_KEY, false);
}

/**
 * Marks the New action as discovered. Called from the New page itself, so any
 * route there (sidebar, command palette, a link) counts, not only the button.
 */
export function useMarkNewActionDiscovered(): void {
  const [discovered, setDiscovered] = useNewActionDiscovered();

  useEffect(() => {
    if (!discovered) setDiscovered(true);
  }, [discovered, setDiscovered]);
}
