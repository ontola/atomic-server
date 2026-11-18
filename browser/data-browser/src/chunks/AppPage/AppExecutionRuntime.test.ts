import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  AppExecutionRegistry,
  type AppExecutionSpec,
} from './AppExecutionRuntime';

afterEach(() => vi.useRealTimers());
const spec = (signal: AbortSignal): AppExecutionSpec => ({
  app: 'table',
  drive: 'drive',
  table: 'table',
  profile: {
    source: 'https://atomic.example/builtin',
    context: {},
    access: {
      root: 'table',
      signal,
      assertCurrent: () => signal.throwIfAborted(),
    },
  },
});
describe('background app executions', () => {
  it('deduplicates a selected execution and discards stale completions', async () => {
    const runs = new AppExecutionRegistry();
    const prepare = vi.fn(async (signal: AbortSignal) => spec(signal));
    await Promise.all([
      runs.start('selected', prepare),
      runs.start('selected', prepare),
    ]);
    expect(prepare).toHaveBeenCalledTimes(1);
    const [first] = runs.getSnapshot();
    runs.cancel('selected');
    expect(first.controller.signal.aborted).toBe(true);
    await runs.start('selected', prepare);
    const [second] = runs.getSnapshot();
    runs.settle(first, { ok: true, children: 0 });
    expect(runs.getSnapshot()).toEqual([second]);
    runs.ready('selected', second.controller.signal);
    runs.settle(second, { ok: true, children: 0 });
    expect(runs.isRunning('selected')).toBe(false);
  });
  it('cancels an execution while its context is still being prepared', async () => {
    const runs = new AppExecutionRegistry();
    let release: (value: AppExecutionSpec) => void = () => undefined;
    let pendingSignal: AbortSignal | undefined;
    const pending = runs.start('selected', signal => {
      pendingSignal = signal;

      return new Promise(resolve => {
        release = resolve;
      });
    });
    runs.clear();
    release(spec(pendingSignal!));
    await expect(pending).rejects.toThrow();
    expect(runs.getSnapshot()).toEqual([]);
  });
  it('records a stalled startup and frees the execution after bounded error reporting', async () => {
    vi.useFakeTimers();
    const runs = new AppExecutionRegistry();
    const failed = vi.fn(async () => new Promise<void>(() => undefined));
    await runs.start('selected', async signal => ({ ...spec(signal), failed }));
    await vi.advanceTimersByTimeAsync(30_000);
    expect(failed).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(runs.isRunning('selected')).toBe(false);
  });
  it('revokes worker authority synchronously while the host reports a failure', async () => {
    const runs = new AppExecutionRegistry();
    let reportSignal: AbortSignal | undefined;
    const failed = vi.fn(async (_message: string, signal: AbortSignal) => {
      reportSignal = signal;

      return new Promise<void>(() => undefined);
    });
    await runs.start('selected', async signal => ({ ...spec(signal), failed }));
    const [run] = runs.getSnapshot();
    runs.settle(run, { ok: false, phase: 'load', message: 'Failed to load' });
    expect(run.controller.signal.aborted).toBe(true);
    expect(() => run.spec!.profile.access.assertCurrent()).toThrow();
    expect(runs.getSnapshot()).toEqual([]);
    await Promise.resolve();
    expect(reportSignal?.aborted).toBe(false);
    runs.settle(run, { ok: true, children: 0 });
    expect(runs.isRunning('selected')).toBe(true);
    runs.cancel('selected');
    expect(reportSignal?.aborted).toBe(true);
  });

  it('prevents an obsolete failure report from overwriting or completing a replacement run', async () => {
    const runs = new AppExecutionRegistry();
    let release!: () => void;
    const waiting = new Promise<void>(resolve => {
      release = resolve;
    });
    const writes: string[] = [];
    let reportSignal: AbortSignal | undefined;
    const failed = vi.fn(async (_message: string, signal: AbortSignal) => {
      reportSignal = signal;
      await waiting;
      signal.throwIfAborted();
      writes.push('obsolete error');
    });
    await runs.start('selected', async signal => ({ ...spec(signal), failed }));
    const [first] = runs.getSnapshot();
    runs.settle(first, { ok: false, phase: 'runtime', message: 'Failed' });
    await Promise.resolve();
    runs.cancel('selected');
    expect(reportSignal?.aborted).toBe(true);
    await runs.start('selected', async signal => spec(signal));
    const [replacement] = runs.getSnapshot();
    release();
    await waiting;
    // Let the obsolete reporter's catch/finally attempt to finish its own run.
    await Promise.resolve();
    await Promise.resolve();
    expect(writes).toEqual([]);
    expect(runs.getSnapshot()).toEqual([replacement]);
    expect(replacement.controller.signal.aborted).toBe(false);
    runs.clear();
  });
  it('disarms startup timeout after the worker handshake', async () => {
    vi.useFakeTimers();
    const runs = new AppExecutionRegistry();
    await runs.start('selected', async signal => spec(signal));
    const [run] = runs.getSnapshot();
    runs.ready('selected', run.controller.signal);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(runs.isRunning('selected')).toBe(true);
    runs.clear();
  });
});
