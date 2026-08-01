/**
 * Local OS notifications (Phase 4).
 *
 * Browser: Web `Notification` API.
 * Tauri desktop/mobile: `@tauri-apps/plugin-notification` (process must be
 * alive — remote push for killed apps is Phase 5).
 *
 * Does not request permission on cold start; call
 * {@link ensureOsNotificationPermission} from a user gesture (first Watch
 * enable, or Settings).
 */

import { isRunningInTauri } from './tauri';

export type OsNotificationPermission =
  | 'granted'
  | 'denied'
  | 'default'
  | 'unsupported';

export type ShowOsNotificationInput = {
  /** NotificationItem subject — used as tag / stable id for cancel. */
  subject: string;
  title: string;
  body?: string;
  /** Resource to open on click (`about`). */
  about?: string;
};

const webNotificationsBySubject = new Map<string, Notification>();

/** Stable 32-bit id for Tauri cancel/removeActive (must be a number). */
export function notificationNumericId(subject: string): number {
  let hash = 0;

  for (let i = 0; i < subject.length; i++) {
    hash = (Math.imul(31, hash) + subject.charCodeAt(i)) | 0;
  }

  return hash === 0 ? 1 : hash;
}

/** True when the document/tab is not the focused foreground surface. */
export function shouldUseOsSurface(): boolean {
  if (typeof document === 'undefined') {
    return false;
  }

  return document.visibilityState === 'hidden' || !document.hasFocus();
}

export async function getOsNotificationPermission(): Promise<OsNotificationPermission> {
  if (isRunningInTauri()) {
    try {
      const { isPermissionGranted } = await import(
        '@tauri-apps/plugin-notification'
      );

      return (await isPermissionGranted()) ? 'granted' : 'default';
    } catch {
      return 'unsupported';
    }
  }

  if (typeof Notification === 'undefined') {
    return 'unsupported';
  }

  return Notification.permission as OsNotificationPermission;
}

/**
 * Request OS notification permission. Call from a user gesture.
 * Returns whether we may show notifications afterwards.
 */
export async function ensureOsNotificationPermission(): Promise<boolean> {
  if (isRunningInTauri()) {
    try {
      const { isPermissionGranted, requestPermission } = await import(
        '@tauri-apps/plugin-notification'
      );

      if (await isPermissionGranted()) {
        return true;
      }

      return (await requestPermission()) === 'granted';
    } catch {
      return false;
    }
  }

  if (typeof Notification === 'undefined') {
    return false;
  }

  if (Notification.permission === 'granted') {
    return true;
  }

  if (Notification.permission === 'denied') {
    return false;
  }

  return (await Notification.requestPermission()) === 'granted';
}

export type ShowOsNotificationResult =
  | { shown: true }
  | { shown: false; reason: 'permission' | 'unsupported' | 'error' };

/**
 * Show a local OS notification. Does **not** request permission — returns
 * `{ shown: false, reason: 'permission' }` when not granted.
 */
export async function showOsNotification(
  input: ShowOsNotificationInput,
  opts?: { onClick?: (about?: string) => void },
): Promise<ShowOsNotificationResult> {
  const permission = await getOsNotificationPermission();

  if (permission === 'unsupported') {
    return { shown: false, reason: 'unsupported' };
  }

  if (permission !== 'granted') {
    return { shown: false, reason: 'permission' };
  }

  try {
    if (isRunningInTauri()) {
      const { sendNotification } = await import(
        '@tauri-apps/plugin-notification'
      );
      const id = notificationNumericId(input.subject);

      sendNotification({
        id,
        title: input.title,
        body: input.body,
        extra: {
          subject: input.subject,
          about: input.about ?? '',
        },
      });

      return { shown: true };
    }

    const existing = webNotificationsBySubject.get(input.subject);
    existing?.close();

    const n = new Notification(input.title, {
      body: input.body,
      tag: input.subject,
      // Keep quiet-ish; product sound prefs are later.
      silent: false,
    });

    n.onclick = () => {
      window.focus();
      opts?.onClick?.(input.about);
      n.close();
    };

    n.onclose = () => {
      if (webNotificationsBySubject.get(input.subject) === n) {
        webNotificationsBySubject.delete(input.subject);
      }
    };

    webNotificationsBySubject.set(input.subject, n);

    return { shown: true };
  } catch {
    return { shown: false, reason: 'error' };
  }
}

/** Dismiss a previously shown OS notification for this NotificationItem. */
export async function cancelOsNotification(subject: string): Promise<void> {
  const web = webNotificationsBySubject.get(subject);

  if (web) {
    web.close();
    webNotificationsBySubject.delete(subject);
  }

  if (!isRunningInTauri()) {
    return;
  }

  try {
    const { cancel, removeActive } = await import(
      '@tauri-apps/plugin-notification'
    );
    const id = notificationNumericId(subject);
    await cancel([id]);
    await removeActive([{ id }]);
  } catch {
    // Plugin missing or cancel unsupported on this platform — ignore.
  }
}
