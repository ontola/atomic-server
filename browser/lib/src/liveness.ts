/**
 * Socket liveness for `WSClient`. The browser cannot see the server's
 * protocol-level pings, so the client decides from inbound-frame silence
 * alone whether to probe (`KEEPALIVE`) or give the socket up. The decision
 * is a pure function of two numbers, kept apart from the socket so it can
 * be tested without one.
 *
 * Silence alone never closes the socket; only an unanswered probe does.
 * A hidden tab's timers are throttled (Chrome batches them to once a minute),
 * so the check can first run long after the socket went quiet. Closing on
 * silence then dropped a healthy connection without ever asking the server,
 * every minute the tab stayed hidden (#1800).
 */

/** After this long without any inbound frame, send a `KEEPALIVE` probe. */
export const LIVENESS_IDLE_MS = 20_000;
/** How long a probe may go unanswered before the socket is presumed dead
 *  and closed so the reconnect loop takes over. Measured from when the probe
 *  was sent, not from the last frame, so a late timer cannot skip the probe.
 *  Comfortably more than a round trip, so one slow echo is not a disconnect. */
export const LIVENESS_PROBE_TIMEOUT_MS = 25_000;
/** How often the liveness timer looks. */
export const LIVENESS_CHECK_MS = 5_000;

export type LivenessAction = 'none' | 'probe' | 'close';

/**
 * What the liveness timer should do given how long the socket has been
 * silent and how long the outstanding probe has gone unanswered (`undefined`
 * when none is outstanding). Pure, so it is testable without a socket:
 * `probe` once past the idle threshold, `close` once a probe has waited past
 * its timeout, otherwise nothing.
 */
export function livenessAction(
  idleMs: number,
  probeAgeMs: number | undefined,
): LivenessAction {
  if (probeAgeMs !== undefined) {
    return probeAgeMs >= LIVENESS_PROBE_TIMEOUT_MS ? 'close' : 'none';
  }

  if (idleMs >= LIVENESS_IDLE_MS) return 'probe';

  return 'none';
}
