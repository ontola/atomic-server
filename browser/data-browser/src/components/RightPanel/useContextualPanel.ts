import { useEffect } from 'react';
import {
  isNotFound,
  isUnauthorized,
  StoreEvents,
  useStore,
  useResourceSnapshot,
} from '@tomic/react';
import { useRightPanel } from './RightPanelContext';
import type { RightPanelId } from './panelState';

/** A loading/offline resource may recover; a missing/inaccessible target cannot. */
export function panelTargetAvailable(subject?: string, error?: Error): boolean {
  return !!subject && !(error && (isNotFound(error) || isUnauthorized(error)));
}

export function useContextualPanel(
  panel: RightPanelId,
  subject?: string,
): boolean {
  const { activePanel, closePanel } = useRightPanel();
  const store = useStore();
  const { error } = useResourceSnapshot(
    activePanel === panel ? subject : undefined,
  );
  const available = panelTargetAvailable(subject, error);
  useEffect(() => {
    if (activePanel === panel && !available) closePanel(panel);
  }, [activePanel, available, panel, closePanel]);
  useEffect(() => {
    if (activePanel !== panel || !subject) return;

    // Deletion evicts the resource; it need not produce a fetch/error snapshot.
    return store.on(StoreEvents.ResourceRemoved, removed => {
      if (store.normalizeSubject(removed) === store.normalizeSubject(subject)) {
        closePanel(panel);
      }
    });
  }, [store, activePanel, panel, subject, closePanel]);

  return activePanel === panel && available;
}
