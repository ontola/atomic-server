import { flushSync } from 'react-dom';

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

const QUEUE_TIMEOUT_MS = 1000;

type NavigatorUAData = {
  mobile?: boolean;
  brands?: Array<{ brand: string }>;
};

/**
 * Desktop Chrome / Chromium is the only place view transitions are known-good.
 * Firefox and Android Chrome implement the API but leave a stuck overlay or
 * skip the animation (https://github.com/ontola/atomic-server/issues/1563).
 */
export function isChromeDesktop(): boolean {
  if (typeof navigator === 'undefined') {
    return false;
  }

  const uaData = (navigator as Navigator & { userAgentData?: NavigatorUAData })
    .userAgentData;

  if (uaData?.brands?.length) {
    const isChromeFamily = uaData.brands.some(
      entry => entry.brand === 'Google Chrome' || entry.brand === 'Chromium',
    );

    return isChromeFamily && uaData.mobile !== true;
  }

  const ua = navigator.userAgent ?? '';

  if (/Android|iPhone|iPad|iPod|Mobile|CriOS|FxiOS/i.test(ua)) {
    return false;
  }

  return /Chrome\//.test(ua);
}

/** Escape hatch: `localStorage.setItem('forceViewTransitions', '1')` */
function forceViewTransitionsEnabled(): boolean {
  try {
    return localStorage.getItem('forceViewTransitions') === '1';
  } catch {
    return false;
  }
}

/** Headless drivers don't paint, so `finished` can hang forever. */
function isAutomated(): boolean {
  if (typeof navigator === 'undefined' || navigator.webdriver !== true) {
    return false;
  }

  return !forceViewTransitionsEnabled();
}

function swallow(promise: Promise<unknown> | undefined) {
  promise?.then(
    () => undefined,
    () => undefined,
  );
}

function skipQuietly(transition: ViewTransition) {
  try {
    transition.skipTransition();
  } catch {
    // Already skipped, finished, or the UA does not implement skip.
  }
}

/**
 * Wrap an async navigation so it runs inside `document.startViewTransition`
 * on desktop Chrome / Chromium when the API exists and the user has not
 * disabled animations.
 *
 * Off everywhere else (Firefox, Android Chrome, Safari): those engines
 * implement the API but duplicate `view-transition-name`s reject `ready` /
 * `updateCallbackDone`, and a hung `finished` promise leaves the
 * `::view-transition` overlay on top of the page. When we do animate, we
 * still always run the navigation, skip a stuck overlay, and never leave
 * those promises unhandled.
 */
export function wrapWithViewTransition<Args extends unknown[]>(
  disabled: boolean,
  cb: (...args: Args) => Promise<void>,
): (...args: Args) => Promise<void> {
  if (
    disabled ||
    typeof document === 'undefined' ||
    !document.startViewTransition ||
    isAutomated() ||
    !(isChromeDesktop() || forceViewTransitionsEnabled())
  ) {
    return cb;
  }

  const wrapped = async (...args: Args) => {
    const previous = activeTransition;
    const gate = Promise.race([
      previous.then(
        () => undefined,
        () => undefined,
      ),
      new Promise<void>(resolve => setTimeout(resolve, QUEUE_TIMEOUT_MS)),
    ]);

    const next = gate.then(async () => {
      let updateStarted = false;

      try {
        const transition = document.startViewTransition!(
          () =>
            new Promise<void>((innerResolve, innerReject) => {
              updateStarted = true;
              flushSync(() => {
                cb(...args).then(innerResolve, innerReject);
              });
            }),
        );

        // Firefox creates these promises during error handling (duplicate
        // names, IB splits) even before we read them — attach catches
        // immediately so they are not unhandled rejections.
        // See https://bugzilla.mozilla.org/show_bug.cgi?id=1999336
        swallow(transition.updateCallbackDone);
        transition.ready.then(undefined, () => skipQuietly(transition));
        swallow(transition.finished);

        await Promise.race([
          transition.finished.then(
            () => undefined,
            () => undefined,
          ),
          new Promise<void>(resolve => {
            setTimeout(() => {
              skipQuietly(transition);
              resolve();
            }, QUEUE_TIMEOUT_MS);
          }),
        ]);
      } catch {
        // Synchronous throw from startViewTransition (Firefox reports some
        // capture errors this way). Still navigate if the update callback
        // never ran.
        if (!updateStarted) {
          await cb(...args);
        }
      }
    });

    activeTransition = next.then(
      () => undefined,
      () => undefined,
    );

    return next;
  };

  return wrapped;
}

/** Test-only: drop in-flight queue state between cases. */
export function resetViewTransitionQueue() {
  activeTransition = Promise.resolve();
}
