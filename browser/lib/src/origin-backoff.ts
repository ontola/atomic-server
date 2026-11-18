import { AtomicError, ErrorType } from './error.js';

/**
 * Per-origin backoff for HTTP resource fetches that never got an answer.
 *
 * A page that lists drives on a server that is gone (an old `localhost` node,
 * a decommissioned staging host) asks for each of them, and asks again on
 * every WebSocket reconnect and every list refresh. Each request fails the
 * same way, so after one fails at the network level the origin is left alone
 * for a while: 30 s, doubling per failed retry, capped at 10 min. A success,
 * a WebSocket opening to that origin, or the browser going `online` clears it.
 *
 * Requests skipped this way fail at once with a transport error, so the
 * resource ends in an explicit "could not reach" state rather than loading.
 */
const BASE_MS = 30_000;
const MAX_MS = 10 * 60_000;

interface OriginState {
  failures: number;
  until: number;
}

const origins = new Map<string, OriginState>();
const skipErrors = new WeakSet<Error>();
let now = () => Date.now();

function originOf(url: string): string | undefined {
  try {
    const { origin } = new URL(url);

    return origin === 'null' ? undefined : origin;
  } catch {
    return undefined;
  }
}

/** A transport error when `url`'s origin is backing off, else undefined. */
export function originBackoffError(url: string): AtomicError | undefined {
  const origin = originOf(url);
  const state = origin ? origins.get(origin) : undefined;

  if (!state || now() >= state.until) return undefined;

  const error = new AtomicError(
    `Could not reach ${origin}; not retrying until ${new Date(state.until).toLocaleTimeString()}`,
    ErrorType.Transport,
  );
  skipErrors.add(error);

  return error;
}

/** True for an error from {@link originBackoffError}: nothing was sent. */
export function isOriginBackoffError(error: unknown): boolean {
  return error instanceof Error && skipErrors.has(error);
}

/** Records a request to `url` that failed before any response. */
export function noteOriginUnreachable(url: string): void {
  const origin = originOf(url);
  if (!origin) return;
  const failures = (origins.get(origin)?.failures ?? 0) + 1;
  const delay = Math.min(BASE_MS * 2 ** (failures - 1), MAX_MS);
  origins.set(origin, { failures, until: now() + delay });
}

/** Clears the backoff of `url`'s origin: it answered. */
export function noteOriginReachable(url: string): void {
  const origin = originOf(url);
  if (origin) origins.delete(origin);
}

/** Forgets every origin; `clock` replaces `Date.now` (tests). */
export function resetOriginBackoff(clock?: () => number): void {
  origins.clear();
  now = clock ?? (() => Date.now());
}

if (typeof window !== 'undefined' && window.addEventListener) {
  window.addEventListener('online', () => origins.clear());
}
