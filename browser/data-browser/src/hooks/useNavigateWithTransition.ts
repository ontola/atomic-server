import { flushSync } from 'react-dom';
import { useSettings } from '../helpers/AppSettings';
import { useNavigate, useRouter } from '@tanstack/react-router';

/**
 * Serializes concurrent view transitions. Without this, back-to-back navigate
 * calls fire `document.startViewTransition()` while the previous transition
 * is still animating — Chrome cancels the older one and logs
 * "Skipped ViewTransition due to another transition starting" to the console.
 * We wait for the prior transition's `finished` promise before starting the
 * next one; failures still unblock the queue so a botched transition can't
 * wedge the UI.
 */
let activeTransition: Promise<void> = Promise.resolve();

// Headless test contexts (Playwright, Puppeteer) don't drive the
// compositor, so `document.startViewTransition`'s update callback can hang
// indefinitely — the navigation inside it never unblocks. Bypass the
// transition wrap there. `navigator.webdriver` is the standard W3C signal
// set by automation drivers.
const IS_AUTOMATED =
  typeof navigator !== 'undefined' && navigator.webdriver === true;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function wrapWithTransition<F extends (...args: any[]) => Promise<void>>(
  disabled: boolean,
  cb: F,
) {
  if (disabled || !document.startViewTransition || IS_AUTOMATED) {
    return cb;
  }

  return async (...args: Parameters<F>) => {
    // Wait for the previous transition to settle, but cap the wait at 1s.
    // Headless test contexts (Playwright/Puppeteer) don't drive the
    // compositor, so a transition's `finished` promise can hang
    // indefinitely — without this cap, one hung transition wedges every
    // subsequent navigation in the queue (the `gate.then(...)` callback
    // would never fire). The new navigation still runs through
    // `startViewTransition`'s update callback, so URL/state changes still
    // happen; we just stop blocking on a previous hang.
    const previous = activeTransition;
    const gate = Promise.race([
      previous.then(
        () => undefined,
        () => undefined,
      ),
      new Promise<void>(resolve => setTimeout(resolve, 1000)),
    ]);
    const next = gate.then(
      () =>
        new Promise<void>(resolve => {
          const transition = document.startViewTransition!(
            () =>
              new Promise<void>(innerResolve => {
                flushSync(() => {
                  cb(...args).then(() => innerResolve());
                });
              }),
          );
          // `finished` resolves/rejects when the animation ends (or is
          // skipped/cancelled). Either way we unblock the queue. Cap the
          // wait so a hung transition can't permanently wedge the queue.
          let settled = false;
          const settle = () => {
            if (settled) return;
            settled = true;
            resolve();
          };
          transition.finished.then(settle, settle);
          setTimeout(settle, 1000);
        }),
    );
    activeTransition = next;

    return next;
  };
}

/**
 * A wrapper around tanstack-router's navigate function that will trigger css view transitions if enabled.
 */
export function useNavigateWithTransition() {
  const navigate = useNavigate();
  const { viewTransitionsDisabled } = useSettings();

  const navigateWithTransition = wrapWithTransition(
    viewTransitionsDisabled,
    (options: Parameters<typeof navigate>[0] | string) => {
      const newOptions =
        typeof options === 'string'
          ? ({
              to: options,
            } satisfies Parameters<typeof navigate>[0])
          : options;

      return navigate(newOptions);
    },
  );

  return navigateWithTransition;
}

export function useBackForward() {
  const router = useRouter();
  const { viewTransitionsDisabled } = useSettings();

  const back = wrapWithTransition(
    viewTransitionsDisabled,
    () =>
      new Promise(resolve => {
        router.history.back();
        setTimeout(() => resolve(), 10);
      }),
  );

  const forward = wrapWithTransition(
    viewTransitionsDisabled,
    () =>
      new Promise(resolve => {
        router.history.forward();
        setTimeout(() => resolve(), 10);
      }),
  );

  return { back, forward };
}
