/**
 * Cold-start / background push-tap queue.
 *
 * Tauri / FCM plugins can deliver a notification click before React listeners
 * are armed. Stash the `about` subject here; the app consumes it once the
 * notification engine / router is ready.
 *
 * Phase 5 scaffold — wire plugin `onNotification` / `getLaunchDetails` into
 * {@link queuePushWakeTap} when the push plugin is chosen.
 */

let pendingAbout: string | undefined;
const listeners = new Set<(about: string) => void>();

export function queuePushWakeTap(about: string): void {
  if (!about) {
    return;
  }

  if (listeners.size > 0) {
    for (const listener of listeners) {
      listener(about);
    }

    return;
  }

  pendingAbout = about;
}

/** Subscribe; immediately receives any queued cold-start tap. */
export function onPushWakeTap(listener: (about: string) => void): () => void {
  listeners.add(listener);

  if (pendingAbout) {
    const about = pendingAbout;
    pendingAbout = undefined;
    listener(about);
  }

  return () => {
    listeners.delete(listener);
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
