import { useEffect, useMemo, useSyncExternalStore } from 'react';
import { createTableDraftCommit } from './draftCommit.js';

export function useTableDraftCommit(scope: string) {
  const controller = useMemo(() => createTableDraftCommit(scope), [scope]);
  const state = useSyncExternalStore(
    controller.subscribe,
    controller.getSnapshot,
    controller.getSnapshot,
  );
  useEffect(() => () => controller.invalidate(), [controller]);

  return {
    ...state,
    run: controller.run,
    runPrepared: controller.runPrepared,
    hasPrepared: controller.hasPrepared,
    clearError: controller.clearError,
  };
}
