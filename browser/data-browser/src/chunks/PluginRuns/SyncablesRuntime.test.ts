import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  SyncablesRunRegistry,
  syncablesSourceSignature,
} from './SyncablesRuntime';
import {
  isSyncablesPresentationOperation,
  syncablesFrameError,
  watchSyncablesWorkerStartup,
} from './SyncablesFrame';

afterEach(() => vi.useRealTimers());

const context = {
  kind: 'mirror',
  platform: 'github-issues',
  proxyOrigin: 'https://proxy.example',
  connectionId: 'test-connection',
  ownerId: '123',
  ownerLogin: 'ontola',
  repoId: '456',
  repoName: 'atomic-server',
};

describe('foreground Syncables run ownership', () => {
  it('deduplicates repeated starts while source validation is pending', async () => {
    let finish: (value: string) => void = () => undefined;
    const source = vi.fn(
      () =>
        new Promise<string>(resolve => {
          finish = resolve;
        }),
    );
    const runtime = new SyncablesRunRegistry(source, () => true);
    const first = runtime.start('drive', 'mirror');
    const second = runtime.start('drive', 'mirror');
    expect(first).toBe(second);
    expect(runtime.isRunning('drive', 'mirror')).toBe(true);
    expect(runtime.getSnapshot()).toHaveLength(0);
    finish(syncablesSourceSignature(context));
    await first;
    expect(source).toHaveBeenCalledTimes(1);
    expect(runtime.getSnapshot()).toHaveLength(1);
    await runtime.start('drive', 'mirror');
    expect(source).toHaveBeenCalledTimes(1);
  });

  it('keeps independent mirrors running until explicitly completed or cancelled', async () => {
    const runtime = new SyncablesRunRegistry(
      async () => syncablesSourceSignature(context),
      () => true,
    );
    await runtime.start('drive', 'first');
    await runtime.start('drive', 'second');
    const [first, second] = runtime.getSnapshot();
    runtime.cancel('drive', 'first');
    expect(first.controller.signal.aborted).toBe(true);
    expect(runtime.isRunning('drive', 'second')).toBe(true);
    runtime.assertActive(second, context);
    runtime.finish(second);
    expect(runtime.getSnapshot()).toHaveLength(0);
  });

  it('prevents an old worker completion from cancelling a later run', async () => {
    const runtime = new SyncablesRunRegistry(
      async () => syncablesSourceSignature(context),
      () => true,
    );
    await runtime.start('drive', 'mirror');
    const [old] = runtime.getSnapshot();
    runtime.finish(old);
    await runtime.start('drive', 'mirror');
    const [current] = runtime.getSnapshot();
    runtime.finish(old);
    expect(runtime.getSnapshot()).toEqual([current]);
    expect(() => runtime.assertActive(old, context)).toThrow();
    runtime.assertActive(current, context);
  });

  it('invalidates a run when its source or current identity changes', async () => {
    let signedIn = true;
    const runtime = new SyncablesRunRegistry(
      async () => syncablesSourceSignature(context),
      () => signedIn,
    );
    await runtime.start('drive', 'mirror');
    const [first] = runtime.getSnapshot();
    runtime.assertActive(first, {
      ...context,
      paused: true,
      presentation: 'worker',
    });
    expect(() =>
      runtime.assertActive(first, { ...context, repoId: '999' }),
    ).toThrow('source');
    expect(first.controller.signal.aborted).toBe(true);
    await runtime.start('drive', 'mirror');
    const [second] = runtime.getSnapshot();
    signedIn = false;
    expect(() => runtime.assertActive(second, context)).toThrow('account');
    expect(second.controller.signal.aborted).toBe(true);
    await expect(runtime.start('drive', 'mirror')).rejects.toThrow('Sign in');
  });

  it('cancels pending validation and removes all jobs on session teardown', async () => {
    let finish: (value: string) => void = () => undefined;
    let signal: AbortSignal | undefined;
    const runtime = new SyncablesRunRegistry(
      async (_drive, _table, pendingSignal) => {
        signal = pendingSignal;

        return new Promise(resolve => {
          finish = resolve;
        });
      },
      () => true,
    );
    const pending = runtime.start('drive', 'mirror');
    runtime.clear();
    expect(signal?.aborted).toBe(true);
    finish(syncablesSourceSignature(context));
    await expect(pending).rejects.toThrow();
    expect(runtime.isRunning('drive', 'mirror')).toBe(false);
    expect(runtime.getSnapshot()).toHaveLength(0);
  });
});

describe('Syncables presentation permissions', () => {
  it('restricts workers to their bound mirror reads and imports', () => {
    expect(isSyncablesPresentationOperation('worker', 'syncablesRead')).toBe(
      true,
    );
    expect(
      isSyncablesPresentationOperation('worker', 'syncablesImportIssues'),
    ).toBe(true);
    expect(
      isSyncablesPresentationOperation('worker', 'syncablesSyncFinished'),
    ).toBe(true);
    for (const op of [
      'syncablesConnect',
      'syncablesOpenAccount',
      'syncablesCreateMirror',
      'syncablesOpenDirectoryRow',
      'syncablesDirectoryRows',
      'syncablesStartSync',
      'syncablesSetPaused',
    ])
      expect(isSyncablesPresentationOperation('worker', op)).toBe(false);
  });

  it('brokers visible sync while restricting provider browsing to directory views', () => {
    for (const op of [
      'syncablesStartSync',
      'syncablesSyncState',
      'syncablesPauseSync',
    ])
      expect(isSyncablesPresentationOperation('sync', op)).toBe(true);
    expect(
      isSyncablesPresentationOperation('sync', 'syncablesImportIssues'),
    ).toBe(false);
    expect(isSyncablesPresentationOperation('sync', 'syncablesRead')).toBe(
      true,
    );
    expect(
      isSyncablesPresentationOperation('directory', 'syncablesDirectoryRows'),
    ).toBe(true);
    expect(
      isSyncablesPresentationOperation(
        'directory',
        'syncablesOpenDirectoryRow',
      ),
    ).toBe(true);
    expect(
      isSyncablesPresentationOperation('directory', 'syncablesImportIssues'),
    ).toBe(false);
    expect(
      isSyncablesPresentationOperation('directory', 'syncablesSyncFinished'),
    ).toBe(false);
    expect(
      isSyncablesPresentationOperation('directory', 'syncablesStartSync'),
    ).toBe(false);
  });
});

describe('Syncables worker startup failures', () => {
  it('clears a running job when the worker never reaches its context handshake', async () => {
    vi.useFakeTimers();
    const runtime = new SyncablesRunRegistry(
      async () => syncablesSourceSignature(context),
      () => true,
    );
    await runtime.start('drive', 'mirror');
    const [run] = runtime.getSnapshot();
    const fail = vi.fn(() => runtime.finish(run));
    const startup = watchSyncablesWorkerStartup(fail);
    vi.advanceTimersByTime(29_999);
    expect(runtime.isRunning('drive', 'mirror')).toBe(true);
    vi.advanceTimersByTime(1);
    expect(fail).toHaveBeenCalledWith(
      expect.stringContaining('Could not start'),
    );
    expect(runtime.isRunning('drive', 'mirror')).toBe(false);
    expect(run.controller.signal.aborted).toBe(true);
    startup.close();
  });

  it('clears the startup timeout on the context handshake and still catches later shell failure once', () => {
    vi.useFakeTimers();
    const fail = vi.fn();
    const startup = watchSyncablesWorkerStartup(fail);
    startup.ready();
    vi.advanceTimersByTime(60_000);
    expect(fail).not.toHaveBeenCalled();
    const message = syncablesFrameError({
      type: '__atomic_plugin_error',
      phase: 'load',
      message: 'Module did not load',
    });
    expect(message).toBe('Module did not load');
    startup.error(message!);
    startup.error('Duplicate shell error');
    expect(fail).toHaveBeenCalledExactlyOnceWith('Module did not load');
    startup.close();
  });

  it('disarms the watchdog on unmount and bounds shell error messages', () => {
    vi.useFakeTimers();
    const fail = vi.fn();
    const startup = watchSyncablesWorkerStartup(fail);
    startup.close();
    vi.advanceTimersByTime(60_000);
    startup.error('Late frame error');
    expect(fail).not.toHaveBeenCalled();
    expect(
      syncablesFrameError({ type: 'atomic.view.request' }),
    ).toBeUndefined();
    expect(syncablesFrameError(null)).toBeUndefined();
    expect(
      syncablesFrameError({
        type: '__atomic_plugin_error',
        message: 'a'.repeat(2_000),
      }),
    ).toHaveLength(1_024);
  });
});
