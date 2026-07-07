import { useCallback, useEffect, useMemo, useSyncExternalStore } from 'react';
import type { DrivePresenceManager, PresenceItem } from '@tomic/lib';
import { useStore } from './index.js';
import { useDrive } from './useDrive.js';
import { useCurrentAgent } from './useCurrentAgent.js';

const EMPTY: PresenceItem[] = [];

/** Subscribe to a drive's presence manager and return its live snapshot
 *  (all sessions, including our own). */
function usePresenceSnapshot(): {
  manager: DrivePresenceManager | undefined;
  snapshot: PresenceItem[];
} {
  const store = useStore();
  const [drive] = useDrive();

  const manager = drive ? store.getPresence(drive) : undefined;

  const subscribe = useCallback(
    (callback: () => void) =>
      manager ? manager.subscribe(callback) : () => undefined,
    [manager],
  );

  const snapshot = useSyncExternalStore(
    subscribe,
    () => manager?.getSnapshot() ?? EMPTY,
  );

  return { manager, snapshot };
}

/**
 * Presence of all *other* sessions in the current drive — for drive-wide
 * UI like sidebar dots or a top-bar avatar row. Ephemeral, non-persisted;
 * sessions disappear ~30s after their tab closes or goes offline.
 *
 * Note: one agent with two tabs open appears twice (presence is
 * per-session); dedupe by `agent` where that's unwanted.
 */
export function useDrivePresence<T = unknown>(): PresenceItem<T>[] {
  const { manager, snapshot } = usePresenceSnapshot();

  return useMemo(
    () =>
      snapshot.filter(
        item => item.sessionId !== manager?.sessionId,
      ) as PresenceItem<T>[],
    [snapshot, manager],
  );
}

/**
 * Announce that this session is viewing `subject`, and get the presence of
 * other sessions viewing it (issue #1229).
 *
 * `setData` attaches a view-specific payload (canvas XY, table cell, …) to
 * our announcement; it lands in the `data` field of the `PresenceItem`
 * other clients see. To follow a user, navigate to their item's
 * `resource` whenever it changes.
 *
 * There should be at most one announcing caller at a time (the resource
 * page); pass `announce: false` for additional read-only consumers.
 */
export function useResourcePresence<T = unknown>(
  subject: string | undefined,
  options: { announce?: boolean } = {},
): {
  /** Other sessions currently viewing `subject`. */
  presence: PresenceItem<T>[];
  /** Attach/replace the view-specific payload of our announcement. */
  setData: (data: T | undefined) => void;
} {
  const { announce = true } = options;
  const { manager, snapshot } = usePresenceSnapshot();
  const [agent] = useCurrentAgent();
  const agentSubject = agent?.subject;

  // (Re-)announce when the viewed resource, drive manager, or signed-in
  // agent changes. No cleanup on unmount: the next page's hook overwrites
  // the entry, and the manager broadcasts a delete when its last
  // subscriber leaves (e.g. drive switch). Patch (not replace) so fields
  // owned by other features — e.g. follow mode — survive navigation; the
  // view payload is cleared since it described the previous resource.
  useEffect(() => {
    if (announce && manager && subject && agentSubject) {
      manager.patchLocal({ resource: subject, data: undefined });
    }
  }, [announce, manager, subject, agentSubject]);

  const setData = useCallback(
    (data: T | undefined) => {
      if (announce && manager && subject) {
        manager.patchLocal({ resource: subject, data });
      }
    },
    [announce, manager, subject],
  );

  const presence = useMemo(
    () =>
      snapshot.filter(
        item =>
          item.resource === subject && item.sessionId !== manager?.sessionId,
      ) as PresenceItem<T>[],
    [snapshot, subject, manager],
  );

  return { presence, setData };
}
