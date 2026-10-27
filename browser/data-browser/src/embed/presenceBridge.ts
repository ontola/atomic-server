import { useSyncExternalStore } from "react";
import type { PresenceItem, Store } from "@tomic/react";
import type { HostPresenceFields } from "./hostActions";

/**
 * Presence in the Flutter app's embed. The page has no websocket, so the app
 * (Rust `atomic_lib`, `lib/src/host/presence.rs`) is the presence channel:
 *
 * - app to page: `atomicEmbed.presence(drive, items)` feeds the other sessions
 *   into the store's `DrivePresenceManager`, so everything that reads presence
 *   (facepiles, cursors, typing hints, follow) works as on the web;
 * - page to app: what the page writes to its own entry (`data`, `typing`,
 *   `session`) is handed to the app through `reportPresence`, which merges it
 *   into the entry it announces. `resource` and `following` stay the app's;
 * - follow: the app owns who is followed (`setFollow`), because it does the
 *   navigating.
 */

/** Injected entries expire like any peer's (30 s); re-set them well inside. */
const REFRESH_MS = 8_000;
/** Cursors move fast; the app hears at most this often. */
const SEND_EVERY_MS = 120;

/** Feeds the app's view of a drive's presence into the page's store. */
export function createPresenceBridge(store: Store) {
  const last = new Map<string, Map<string, PresenceItem>>();
  let timer: ReturnType<typeof setInterval> | undefined;

  const inject = (drive: string, items: Map<string, PresenceItem>) => {
    const manager = store.getPresence(drive);

    for (const [sessionId, item] of items) {
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const { sessionId: _id, ...entry } = item;

      manager.injectEntry(sessionId, entry);
    }
  };

  return {
    /** The app's current list for `drive`, replacing the previous one. */
    feed(drive: string, items: PresenceItem[]): void {
      const next = new Map(
        items
          .filter((item) => item.sessionId && item.agent)
          .map((item) => [item.sessionId, item] as const),
      );
      const manager = store.getPresence(drive);

      for (const sessionId of last.get(drive)?.keys() ?? []) {
        if (!next.has(sessionId)) manager.removeEntry(sessionId);
      }

      last.set(drive, next);
      inject(drive, next);

      // The app only speaks when something changed; a quiet list would
      // otherwise time out here.
      timer ??= setInterval(() => {
        for (const [d, entries] of last) inject(d, entries);
      }, REFRESH_MS);
    },
    dispose(): void {
      if (timer) clearInterval(timer);
      timer = undefined;

      for (const [drive, entries] of last) {
        const manager = store.getPresence(drive);

        for (const sessionId of entries.keys()) manager.removeEntry(sessionId);
      }

      last.clear();
    },
  };
}

/**
 * Relays the fields of this session's own presence entry that the page owns to
 * the app. Sent when they change, at most every {@link SEND_EVERY_MS}.
 * Returns the stop function.
 */
export function relayLocalPresence(
  store: Store,
  send: (fields: HostPresenceFields) => void,
): () => void {
  // Nothing to say until the page writes something.
  let sent: string | undefined = JSON.stringify({
    data: null,
    typing: null,
    session: null,
  });
  let pending: HostPresenceFields | undefined;
  let cooling: ReturnType<typeof setTimeout> | undefined;

  const flush = () => {
    cooling = undefined;

    if (!pending) return;

    const fields = pending;

    pending = undefined;

    const key = JSON.stringify(fields);

    if (key === sent) return;

    sent = key;
    send(fields);
    cooling = setTimeout(flush, SEND_EVERY_MS);
  };

  const off = store.onLocalPresence((_drive, entry) => {
    pending = {
      data: entry?.data ?? null,
      typing: entry?.typing ?? null,
      session: entry?.session ?? null,
    };

    if (!cooling) flush();
  });

  return () => {
    off();
    clearTimeout(cooling);
    cooling = undefined;
    pending = undefined;
  };
}

// Who the app is following, as it last said.
let hostFollowed: string | undefined;
const followListeners = new Set<() => void>();

/** The app followed (or stopped following) `agent`. */
export function setHostFollow(agent: string | null | undefined): void {
  const next = agent || undefined;

  if (next === hostFollowed) return;

  hostFollowed = next;

  for (const listener of followListeners) listener();
}

/** The agent the app is following; undefined when it follows nobody. */
export function useHostFollow(): string | undefined {
  return useSyncExternalStore(
    (callback) => {
      followListeners.add(callback);

      return () => followListeners.delete(callback);
    },
    () => hostFollowed,
    () => undefined,
  );
}
