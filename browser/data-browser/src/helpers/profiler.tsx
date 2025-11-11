import {
  Profiler,
  type ProfilerOnRenderCallback,
  type ReactNode,
  type JSX,
} from 'react';
import { type Store, StoreEvents } from '@tomic/react';

/**
 * Runtime perf profiler.
 *
 * Wrap the app in `<PerformanceProfiler>`; it forwards every React render
 * through `<React.Profiler>` and accumulates stats per `id`, `phase`, and
 * "slow" bucket (renders > 16ms = one frame at 60 Hz).
 *
 * Press Ctrl/Cmd + Shift + P to dump a snapshot to the console. The same
 * data is exposed at `window.__atomicProfiler.snapshot()` for ad-hoc
 * inspection.
 *
 * Stats are also augmented from outside React via:
 *   `window.__atomicProfiler.tick('store.emit', { subject })`
 * which lets `@tomic/lib` / `@tomic/react` log subscription events the
 * Profiler itself can't see.
 */

interface RenderBucket {
  count: number;
  totalDuration: number;
  maxDuration: number;
  slowRenders: number; // >16ms
}

interface PhaseBuckets {
  mount: RenderBucket;
  update: RenderBucket;
  'nested-update': RenderBucket;
}

interface ProfilerStats {
  byId: Map<string, PhaseBuckets>;
  events: Map<string, { count: number; payloads: unknown[] }>;
  startedAt: number;
}

const SLOW_RENDER_MS = 16;
const KEEP_RECENT_PAYLOADS = 5;

function emptyBucket(): RenderBucket {
  return { count: 0, totalDuration: 0, maxDuration: 0, slowRenders: 0 };
}

function emptyPhaseBuckets(): PhaseBuckets {
  return {
    mount: emptyBucket(),
    update: emptyBucket(),
    'nested-update': emptyBucket(),
  };
}

const stats: ProfilerStats = {
  byId: new Map(),
  events: new Map(),
  startedAt: Date.now(),
};

const onRender: ProfilerOnRenderCallback = (
  id,
  phase,
  actualDuration,
  _baseDuration,
  _startTime,
  _commitTime,
) => {
  let phases = stats.byId.get(id);
  if (!phases) {
    phases = emptyPhaseBuckets();
    stats.byId.set(id, phases);
  }
  const bucket = phases[phase];
  bucket.count += 1;
  bucket.totalDuration += actualDuration;
  if (actualDuration > bucket.maxDuration) bucket.maxDuration = actualDuration;
  if (actualDuration > SLOW_RENDER_MS) bucket.slowRenders += 1;
};

function tick(name: string, payload?: unknown) {
  let entry = stats.events.get(name);
  if (!entry) {
    entry = { count: 0, payloads: [] };
    stats.events.set(name, entry);
  }
  entry.count += 1;
  if (payload !== undefined && entry.payloads.length < KEEP_RECENT_PAYLOADS) {
    entry.payloads.push(payload);
  }
}

function reset() {
  stats.byId.clear();
  stats.events.clear();
  stats.startedAt = Date.now();
}

interface SnapshotRow {
  id: string;
  phase: 'mount' | 'update' | 'nested-update';
  count: number;
  totalMs: number;
  avgMs: number;
  maxMs: number;
  slowRenders: number;
}

interface Snapshot {
  windowSeconds: number;
  totalRenders: number;
  totalRenderMs: number;
  rows: SnapshotRow[];
  events: { name: string; count: number; samplePayloads: unknown[] }[];
}

function snapshot(): Snapshot {
  const rows: SnapshotRow[] = [];
  let totalRenders = 0;
  let totalRenderMs = 0;
  for (const [id, phases] of stats.byId) {
    for (const phase of ['mount', 'update', 'nested-update'] as const) {
      const b = phases[phase];
      if (b.count === 0) continue;
      totalRenders += b.count;
      totalRenderMs += b.totalDuration;
      rows.push({
        id,
        phase,
        count: b.count,
        totalMs: round(b.totalDuration),
        avgMs: round(b.totalDuration / b.count),
        maxMs: round(b.maxDuration),
        slowRenders: b.slowRenders,
      });
    }
  }
  rows.sort((a, b) => b.totalMs - a.totalMs);
  const events = [...stats.events.entries()]
    .map(([name, e]) => ({
      name,
      count: e.count,
      samplePayloads: e.payloads,
    }))
    .sort((a, b) => b.count - a.count);

  return {
    windowSeconds: round((Date.now() - stats.startedAt) / 1000),
    totalRenders,
    totalRenderMs: round(totalRenderMs),
    rows,
    events,
  };
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}

function dumpToConsole() {
  const snap = snapshot();
  // Headline:
  console.groupCollapsed(
    `%c[atomic-profiler] %c${snap.totalRenders} renders / ${snap.totalRenderMs}ms over ${snap.windowSeconds}s`,
    'color: #888',
    'color: inherit; font-weight: bold',
  );
  console.log('Top by total render time:');
  console.table(snap.rows.slice(0, 25));
  if (snap.events.length > 0) {
    console.log('Events (subscribe / emit / fetch):');
    console.table(snap.events.slice(0, 25));
  }
  console.log('Full snapshot:', snap);
  console.log(
    'Reset with `window.__atomicProfiler.reset()`; full data via `window.__atomicProfiler.snapshot()`.',
  );
  console.groupEnd();
}

if (typeof window !== 'undefined') {
  (window as unknown as { __atomicProfiler: unknown }).__atomicProfiler = {
    snapshot,
    dump: dumpToConsole,
    reset,
    tick,
    raw: stats,
  };

  window.addEventListener('keydown', e => {
    if (
      (e.ctrlKey || e.metaKey) &&
      e.shiftKey &&
      (e.key === 'P' || e.key === 'p')
    ) {
      e.preventDefault();
      dumpToConsole();
    }
  });
}

export const profilerTick = tick;

/**
 * Wire `Store` events into the profiler so resource updates / saves /
 * commit traffic show up alongside React render counts. Call once at
 * startup with the live store.
 */
export function attachStoreToProfiler(store: Store): void {
  store.on(StoreEvents.ResourceUpdated, resource => {
    tick('store.ResourceUpdated', short(resource.subject));
  });
  store.on(StoreEvents.ResourceSaved, resource => {
    tick('store.ResourceSaved', short(resource.subject));
  });
  store.on(StoreEvents.CommitLogChanged, () => {
    tick('store.CommitLogChanged');
  });
}

function short(s: string): string {
  return s.length > 50 ? s.slice(0, 50) + '…' : s;
}

export function PerformanceProfiler({
  children,
  id = 'app',
}: {
  children: ReactNode;
  id?: string;
}): JSX.Element {
  return (
    <Profiler id={id} onRender={onRender}>
      {children}
    </Profiler>
  );
}
