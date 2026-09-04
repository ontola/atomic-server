/**
 * Socket liveness for `WSClient`. The browser cannot see the server's
 * protocol-level pings, so the client decides from inbound-frame silence
 * alone whether to probe (`KEEPALIVE`) or give the socket up. The decision
 * is a pure function of two numbers, kept apart from the socket so it can
 * be tested without one.
 */

/** After this long without any inbound frame, send a `KEEPALIVE` probe. */
export const LIVENESS_IDLE_MS = 20_000;
/** After this long without any inbound frame, the socket is presumed dead
 *  and closed so the reconnect loop takes over. Comfortably more than the
 *  idle threshold plus a round trip, so one slow echo is not a disconnect. */
export const LIVENESS_DEADLINE_MS = 45_000;
/** How often the liveness timer looks. */
export const LIVENESS_CHECK_MS = 5_000;

export type LivenessAction = 'none' | 'probe' | 'close';

/**
 * What the liveness timer should do given how long the socket has been
 * silent and whether a probe is already outstanding. Pure, so it is testable
 * without a socket: `probe` once past the idle threshold, `close` once past
 * the deadline, otherwise nothing.
 */
export function livenessAction(
  idleMs: number,
  probeSent: boolean,
): LivenessAction {
  if (idleMs >= LIVENESS_DEADLINE_MS) return 'close';
  if (idleMs >= LIVENESS_IDLE_MS && !probeSent) return 'probe';

  return 'none';
}
