/**
 * Lightweight always-on perf trace.
 *
 * Records named events with timestamp + optional payload. Used to build a
 * wall-clock picture of what `@tomic/lib` is spending time on during a
 * test, so we can compare local-vs-CI budgets without spinning up a real
 * profiler.
 *
 * Two primitives:
 *   - `perfMark(name, payload?)` — record a single timestamped event.
 *   - `perfSpan(name, payload?)` — start a span, returns a closer that
 *     records the duration when called.
 *
 * Snapshots come back via `perfSnapshot()`; the e2e harness attaches
 * them to test output via `window.__atomicPerf`. Cost is one timestamp +
 * a push per call; we keep at most `MAX_EVENTS` to bound memory in
 * long-running sessions.
 *
 * Off-the-hot-path: never throws, never awaits, no hashing or
 * serialisation. Fine to leave on in production.
 */

export interface PerfEvent {
  name: string;
  /** Wall-clock from `performance.now()`. */
  t: number;
  /** Duration in ms when this is a span end (undefined for a mark). */
  d?: number;
  /** Optional small payload — should be JSON-stringifiable. */
  p?: unknown;
}

const MAX_EVENTS = 5000;

function nowMs(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

/**
 * The buffer lives on `globalThis`, not in this module.
 *
 * A bundler is free to hand the same source to more than one graph — the app
 * and a worker, a pre-bundled dependency and an aliased build — and each copy
 * would then keep its own `events` array. Whichever copy loaded last owns
 * `window.__atomicPerf`, so the reader could be a different copy than the one
 * doing the recording: `opfs-init-perf` and `table-create-perf` both read an
 * empty trace while the app was busily filling another one. One buffer keyed
 * on the global object, and every copy writes and reads the same trace.
 */
interface PerfState {
  events: PerfEvent[];
  originTime: number;
}

const globalScope = globalThis as typeof globalThis & {
  __atomicPerfState?: PerfState;
};

const state: PerfState = (globalScope.__atomicPerfState ??= {
  events: [],
  originTime: nowMs(),
});

export function perfMark(name: string, payload?: unknown): void {
  if (state.events.length >= MAX_EVENTS) return;
  state.events.push({ name, t: nowMs() - state.originTime, p: payload });
}

export function perfSpan(
  name: string,
  payload?: unknown,
): (resultPayload?: unknown) => void {
  const start = nowMs();
  const startEvent: PerfEvent = {
    name: name + ':start',
    t: start - state.originTime,
    p: payload,
  };
  if (state.events.length < MAX_EVENTS) state.events.push(startEvent);

  return (resultPayload?: unknown) => {
    if (state.events.length >= MAX_EVENTS) return;
    const end = nowMs();
    state.events.push({
      name,
      t: end - state.originTime,
      d: end - start,
      p: resultPayload,
    });
  };
}

export interface PerfSnapshot {
  windowMs: number;
  count: number;
  events: PerfEvent[];
  /**
   * Aggregated rollup: per-name count, total duration (for spans),
   * max duration. Useful for spotting the slow path at a glance.
   */
  rollup: Array<{
    name: string;
    count: number;
    totalMs: number;
    maxMs: number;
    avgMs: number;
  }>;
}

export function perfSnapshot(): PerfSnapshot {
  const rollupMap = new Map<
    string,
    { count: number; totalMs: number; maxMs: number }
  >();

  for (const e of state.events) {
    const existing = rollupMap.get(e.name);
    const dur = e.d ?? 0;

    if (existing) {
      existing.count += 1;
      existing.totalMs += dur;
      if (dur > existing.maxMs) existing.maxMs = dur;
    } else {
      rollupMap.set(e.name, { count: 1, totalMs: dur, maxMs: dur });
    }
  }

  const rollup = [...rollupMap.entries()]
    .map(([name, agg]) => ({
      name,
      count: agg.count,
      totalMs: round(agg.totalMs),
      maxMs: round(agg.maxMs),
      avgMs: round(agg.totalMs / agg.count),
    }))
    .sort((a, b) => b.totalMs - a.totalMs);

  return {
    windowMs: round(nowMs() - state.originTime),
    count: state.events.length,
    events: state.events.slice(),
    rollup,
  };
}

export function perfReset(): void {
  state.events = [];
  state.originTime = nowMs();
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}

// Expose to window for browser/e2e access. Skipped in Node tests where
// `window` is undefined.
if (typeof window !== 'undefined') {
  (window as unknown as { __atomicPerf?: unknown }).__atomicPerf = {
    mark: perfMark,
    span: perfSpan,
    snapshot: perfSnapshot,
    reset: perfReset,
  };
}
