// @wc-ignore-file
// Notifications from the operating system, on the web and in the app.
//
// One code path for both: in the Tauri app, `tauri-plugin-notification`
// replaces `window.Notification` with one backed by the OS (desktop and
// Android), so the web Notification API is all this module needs.
//
// Whether they're on is per device, like the permission itself: the same
// person may want them on their laptop and not in a shared browser.

const PREF_KEY = 'atomic.osNotifications';

export type OsNotificationState = 'unsupported' | 'blocked' | 'off' | 'on';

export function osNotificationsSupported(): boolean {
  return typeof window !== 'undefined' && 'Notification' in window;
}

function turnedOff(): boolean {
  try {
    return localStorage.getItem(PREF_KEY) === 'off';
  } catch {
    return false;
  }
}

function setTurnedOff(off: boolean) {
  try {
    if (off) {
      localStorage.setItem(PREF_KEY, 'off');
    } else {
      localStorage.removeItem(PREF_KEY);
    }
  } catch {
    // Storage blocked: the permission still decides.
  }
}

export function osNotificationState(): OsNotificationState {
  if (!osNotificationsSupported()) return 'unsupported';
  if (Notification.permission === 'denied') return 'blocked';
  if (Notification.permission !== 'granted' || turnedOff()) return 'off';

  return 'on';
}

/** Asks for permission if needed. Call from a click: browsers require it. */
export async function turnOnOsNotifications(): Promise<OsNotificationState> {
  if (!osNotificationsSupported()) return 'unsupported';

  setTurnedOff(false);

  if (Notification.permission !== 'granted') {
    try {
      await Notification.requestPermission();
    } catch (e) {
      console.error('Could not ask for notification permission:', e);
    }
  }

  return osNotificationState();
}

export function turnOffOsNotifications(): void {
  setTurnedOff(true);
}

export interface OsNotification {
  title: string;
  body: string;
  /** Replaces an earlier notification with the same tag. */
  tag: string;
  onClick: () => void;
}

export function showOsNotification({
  title,
  body,
  tag,
  onClick,
}: OsNotification): void {
  if (osNotificationState() !== 'on') return;

  try {
    const notification = new Notification(title, { body, tag });

    notification.onclick = () => {
      window.focus();
      onClick();
      notification.close?.();
    };
  } catch {
    // Chrome on Android only shows notifications through a service worker,
    // and refuses the constructor. Use one if the page has it.
    void navigator.serviceWorker
      ?.getRegistration()
      .then(reg => reg?.showNotification(title, { body, tag }))
      .catch(() => {});
  }
}
