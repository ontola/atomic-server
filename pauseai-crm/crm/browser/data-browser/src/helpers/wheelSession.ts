/**
 * Global wheel-session tracker.
 *
 * Installs a passive, capture-phase `wheel` listener on `window` as a
 * side effect of importing this module. Use {@link currentWheelSessionStartedAt}
 * to read the timestamp (in `performance.now()` units) when the *current*
 * wheel-scroll session began. A "session" is a contiguous burst of wheel
 * events with gaps smaller than {@link WHEEL_SESSION_GAP_MS} between them
 * — i.e. one continuous flick + its momentum tail.
 *
 * Why a module singleton and not a hook: a route that mounts mid-flick
 * (e.g. CanvasPage after swipe-back) can't install its own listener
 * "early enough" — the OS already sent the first momentum wheel event by
 * the time React commits. This tracker has to be running before any
 * route swaps in. Importing it from `index.tsx` (the app entry) ensures
 * it boots before the first wheel event from any view.
 *
 * The intended consumer is `CanvasPage`, which compares the session-start
 * time to the time the canvas was mounted: if the session predates the
 * mount, the wheel events are momentum carried over from the previous
 * view and should be ignored. See `views/Canvas/CanvasPage.tsx`.
 */

/** Wheel events more than this many milliseconds apart start a new session. */
export const WHEEL_SESSION_GAP_MS = 150;

let lastWheelAt = 0;
let sessionStart = 0;

if (typeof window !== 'undefined') {
  window.addEventListener(
    'wheel',
    () => {
      const now = performance.now();

      if (now - lastWheelAt > WHEEL_SESSION_GAP_MS) {
        sessionStart = now;
      }

      lastWheelAt = now;
    },
    { capture: true, passive: true },
  );
}

/**
 * Returns the `performance.now()` timestamp at which the most recent wheel
 * session began. `0` if no wheel events have been observed yet in this
 * page lifetime.
 */
export function currentWheelSessionStartedAt(): number {
  return sessionStart;
}
