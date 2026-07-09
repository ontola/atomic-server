import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useSyncExternalStore,
} from 'react';
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
 * `setData` attaches a view-specific payload (canvas pointer XY, table
 * cell, …) to our announcement; it lands in the `data` field of the
 * `PresenceItem` other clients see. To follow a user, navigate to their
 * item's `resource` whenever it changes.
 *
 * Announcing callers must agree on the subject: the NavBar announces the
 * currently viewed resource, and a view of that same resource may call
 * this hook again to attach `data` (see the canvas + table views in
 * data-browser) — same-subject announcers compose harmlessly. Pass
 * `announce: false` for read-only consumers.
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

/** How long after the last keystroke we consider the user to have stopped
 *  typing, if they don't send or blur first. Well under the presence TTL. */
const TYPING_IDLE_MS = 4000;

/**
 * Announce that this session is typing a message in the thread `subject` (a
 * comment thread or a chatroom), and read the other sessions doing the same —
 * a shared "who is typing here" channel for any {@link PresenceItem}-backed
 * surface.
 *
 * Call `notifyTyping()` on every keystroke: it announces once and keeps the
 * announcement fresh, auto-clearing after {@link TYPING_IDLE_MS} of silence.
 * Call `stopTyping()` when the composer sends, blurs, empties or unmounts.
 * (Clearing matters: the presence heartbeat would otherwise keep a stale
 * `typing` alive for the whole session — the 30s TTL is only a backstop.)
 *
 * `typers` excludes our own session and collapses an agent's multiple tabs to
 * one entry.
 */
export function useTypingPresence(subject: string | undefined): {
  /** Other agents currently typing in `subject` (deduped by agent). */
  typers: PresenceItem[];
  /** Mark this session as typing in `subject`; safe to call every keystroke. */
  notifyTyping: () => void;
  /** Clear this session's typing announcement immediately. */
  stopTyping: () => void;
} {
  const { manager, snapshot } = usePresenceSnapshot();
  const [agent] = useCurrentAgent();
  const agentSubject = agent?.subject;

  // Whether we currently advertise `typing`, so keystrokes after the first
  // don't re-broadcast — the idle timer alone keeps it fresh.
  const activeRef = useRef(false);
  const idleTimer = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  );

  const stopTyping = useCallback(() => {
    if (idleTimer.current) {
      clearTimeout(idleTimer.current);
      idleTimer.current = undefined;
    }

    if (activeRef.current) {
      activeRef.current = false;
      manager?.patchLocal({ typing: undefined });
    }
  }, [manager]);

  const notifyTyping = useCallback(() => {
    if (!manager || !subject || !agentSubject) {
      return;
    }

    if (!activeRef.current) {
      activeRef.current = true;
      manager.patchLocal({ typing: subject });
    }

    if (idleTimer.current) {
      clearTimeout(idleTimer.current);
    }

    idleTimer.current = setTimeout(stopTyping, TYPING_IDLE_MS);
  }, [manager, subject, agentSubject, stopTyping]);

  // Stop announcing when the thread changes or the composer unmounts — the
  // previous `typing` value would otherwise linger via the heartbeat.
  useEffect(() => stopTyping, [subject, stopTyping]);

  const typers = useMemo(() => {
    const seen = new Set<string>();

    return snapshot.filter(item => {
      if (item.typing !== subject || item.sessionId === manager?.sessionId) {
        return false;
      }

      // One entry per agent (a person with two tabs isn't "two typers"), and
      // never surface ourselves from another tab.
      if (item.agent === agentSubject || seen.has(item.agent)) {
        return false;
      }

      seen.add(item.agent);

      return true;
    });
  }, [snapshot, subject, manager, agentSubject]);

  return { typers, notifyTyping, stopTyping };
}
