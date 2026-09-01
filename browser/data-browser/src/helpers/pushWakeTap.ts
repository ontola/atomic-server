/**
 * Cold-start / background push queues.
 *
 * Tauri / FCM plugins can deliver a wake or notification click before React
 * listeners are armed. Stash here; the app consumes once the notification
 * engine / router is ready.
 *
 * Phase 5 — wire plugin `onNotification` / `getLaunchDetails` into
 * {@link queuePushWakeTap} / {@link queuePushWakeReceive} when the push
 * plugin is chosen.
 */

export type PushWakeReceive = { about: string; type: string };

let pendingAbout: string | undefined;
const tapListeners = new Set<(about: string) => void>();

let pendingReceive: PushWakeReceive | undefined;
const receiveListeners = new Set<(wake: PushWakeReceive) => void>();

export function queuePushWakeTap(about: string): void {
  if (!about) {
    return;
  }

  if (tapListeners.size > 0) {
    for (const listener of tapListeners) {
      listener(about);
    }

    return;
  }

  pendingAbout = about;
}

/** Subscribe; immediately receives any queued cold-start tap. */
export function onPushWakeTap(listener: (about: string) => void): () => void {
  tapListeners.add(listener);

  if (pendingAbout) {
    const about = pendingAbout;
    pendingAbout = undefined;
    listener(about);
  }

  return () => {
    tapListeners.delete(listener);
  };
}

/** Peek without clearing (tests). */
export function peekPushWakeTap(): string | undefined {
  return pendingAbout;
}

/** Clear without navigating (tests / dismiss). */
export function clearPushWakeTap(): void {
  pendingAbout = undefined;
}

/**
 * Queue a data/silent wake (not a user tap). Consumed by
 * {@link NotificationOsPresenter} → {@link processPushWake}.
 */
export function queuePushWakeReceive(wake: PushWakeReceive): void {
  if (!wake.about) {
    return;
  }

  if (receiveListeners.size > 0) {
    for (const listener of receiveListeners) {
      listener(wake);
    }

    return;
  }

  pendingReceive = wake;
}

/** Subscribe; immediately receives any queued wake. */
export function onPushWakeReceive(
  listener: (wake: PushWakeReceive) => void,
): () => void {
  receiveListeners.add(listener);

  if (pendingReceive) {
    const wake = pendingReceive;
    pendingReceive = undefined;
    listener(wake);
  }

  return () => {
    receiveListeners.delete(listener);
  };
}

export function peekPushWakeReceive(): PushWakeReceive | undefined {
  return pendingReceive;
}

export function clearPushWakeReceive(): void {
  pendingReceive = undefined;
}
