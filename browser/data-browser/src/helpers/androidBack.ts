// @wc-ignore-file
// The Android back button in the Tauri app.
//
// Left alone, Tauri sends back straight to the webview's history: with the
// sidebar drawer or a dialog open, back navigates away underneath it instead
// of closing it, which is not what any Android app does. Tauri lets the page
// take over back by listening for it, but a listener takes over *all* of it —
// including leaving the app from the first page, which the page can't do.
//
// So a listener is only registered while something wants back: an open
// drawer or dialog pushes a handler, and when the last one is gone the
// listener is removed and back is Tauri's again (history, then exit).
import { useEffect, useEffectEvent } from 'react';
import { isMobileTauri } from './tauri';

type BackHandler = () => void;

interface Listener {
  unregister: () => Promise<void>;
}

type Register = (
  onBack: (payload: { canGoBack: boolean }) => void,
) => Promise<Listener>;

const registerWithTauri: Register = async onBack => {
  const { onBackButtonPress } = await import('@tauri-apps/api/app');

  return onBackButtonPress(onBack);
};

/** Exported for tests; the app uses the default instance below. */
export function createBackStack(register: Register) {
  const handlers: BackHandler[] = [];
  let registration: Promise<Listener | undefined> | undefined;

  const sync = () => {
    if (handlers.length > 0 && !registration) {
      const own: Promise<Listener | undefined> = register(({ canGoBack }) => {
        // A listener that is being removed can still fire once. Only the
        // current one acts, so one press never closes two things.
        if (registration !== own) return;

        const top = handlers.at(-1);

        if (top) {
          top();
        } else if (canGoBack) {
          window.history.back();
        }
      }).catch(e => {
        console.error('Could not listen for the back button:', e);

        return undefined;
      });
      registration = own;
    } else if (handlers.length === 0 && registration) {
      const old = registration;
      registration = undefined;
      void old.then(listener => listener?.unregister()).catch(() => {});
    }
  };

  return {
    /** Adds a handler on top; returns the function that removes it. */
    push(handler: BackHandler): () => void {
      handlers.push(handler);
      sync();

      return () => {
        const index = handlers.lastIndexOf(handler);

        if (index !== -1) handlers.splice(index, 1);

        sync();
      };
    },
  };
}

const backStack = createBackStack(registerWithTauri);

// iOS has no back button, and its app plugin has no back event to listen to.
const isAndroidApp = () =>
  isMobileTauri() && /android/i.test(navigator.userAgent);

/**
 * While `active`, the Android back button calls `onBack` instead of
 * navigating. The most recently activated caller wins, so a dialog opened
 * from the drawer closes before the drawer does. Does nothing outside the
 * Android app.
 */
export function useAndroidBack(active: boolean, onBack: () => void): void {
  const handle = useEffectEvent(onBack);

  useEffect(() => {
    if (!active || !isAndroidApp()) return;

    return backStack.push(() => handle());
  }, [active]);
}
