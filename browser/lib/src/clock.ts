let offsetMs = 0;

/**
 * Milliseconds to add to this device's clock to match the servers'. Only ever
 * negative: a device running ahead has its commits and auth proofs refused as
 * "must lie in the past", while one running behind is merely early, which
 * servers accept.
 */
export function getClockOffset(): number {
  return offsetMs;
}

/** Learn from a server's current time (ms since epoch). */
export function noteServerClock(serverNowMs: number): void {
  if (!Number.isFinite(serverNowMs)) return;

  const offset = serverNowMs - Date.now();

  // Ignore small skew (network latency, Date header second precision).
  offsetMs = offset < -2000 ? offset : 0;
}

/** Learn from a `Date` response header (second precision, so it errs early). */
export function noteServerDateHeader(value: string | null | undefined): void {
  if (!value) return;

  const parsed = Date.parse(value);

  if (!Number.isNaN(parsed)) noteServerClock(parsed);
}

/** Learn from a server's "Timestamp now: <ms>" rejection message. */
export function noteServerClockFromMessage(message: string): void {
  const match = /Timestamp now: (\d{12,14})/.exec(message);

  if (match) noteServerClock(Number(match[1]));
}

export function trustedNow(): number {
  return Date.now() + offsetMs;
}
