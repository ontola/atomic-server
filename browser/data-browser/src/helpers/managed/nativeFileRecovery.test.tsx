// @vitest-environment jsdom
// @wc-ignore-file
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { Store } from '@tomic/lib';
import { Store as SourceStore } from '../../../../lib/src/store';
import { StoreContext } from '../../../../react/src/hooks';
import { useBlobObjectUrl } from '../../../../react/src/useFileObjectUrl';
import { startAutomaticFileRecovery } from './automaticFileRecovery';
import type { VaultCapableDb } from './vault';
import type { repairDriveFiles } from './vaultFileRepair';

const A = 'aa'.repeat(32);
const B = 'bb'.repeat(32);
const DRIVE = 'atomic:native-drive';
const FALLBACK = `http://localhost:9883/download/files/${A}?inline=true#preview`;
const disposers: (() => void)[] = [];

function fixture() {
  const source = new SourceStore({ noServer: true });
  source.setAgent({
    subject: 'atomic:agent:native-alice',
  } as Parameters<SourceStore['setAgent']>[0]);
  source.setDrive(DRIVE);
  // Use the actual Store implementation with the React package's structural
  // boundary. Both packages resolve their public Store type independently.
  const store = source as unknown as Store;
  const state = { local: new Set<string>(), refs: [A] };
  const db = {
    vaultExport: vi.fn(),
    vaultImport: vi.fn(),
    vaultCommitSegment: vi.fn(),
    vaultFileHashes: vi.fn(async () => state.refs),
    vaultBlobPresent: vi.fn(async (hash: string) => state.local.has(hash)),
    vaultBlobRestore: vi.fn(),
  } satisfies VaultCapableDb;
  let notifyFilesStored: (hash: string | null) => void = () => {};
  const unsubscribe = vi.fn();
  const deps = {
    db: () => db,
    peers: vi.fn(
      async (
        _store: Store,
        _drive: string,
        _hashes: string[],
        _signal: AbortSignal,
      ) => {},
    ),
    account: vi.fn(() => new Promise<string | null>(() => {})),
    credentials: vi.fn(async () => ({
      drivePseudonym: 'native-vault',
      driveKey: new Uint8Array(32).fill(7),
      keyEpoch: 1,
    })),
    repair: vi.fn(
      (..._args: Parameters<typeof repairDriveFiles>) =>
        new Promise<Awaited<ReturnType<typeof repairDriveFiles>>>(() => {}),
    ),
    onFilesStored: (callback: typeof notifyFilesStored) => {
      notifyFilesStored = callback;

      return unsubscribe;
    },
  };
  const dispose = startAutomaticFileRecovery(store, deps);
  disposers.push(dispose);
  const view = render(
    <StoreContext.Provider value={store}>
      <NativePreview />
    </StoreContext.Provider>,
  );

  return {
    store,
    source,
    state,
    deps,
    db,
    dispose,
    view,
    unsubscribe,
    notify: (hash: string | null) => notifyFilesStored(hash),
  };
}

function NativePreview({ hash = A }: { hash?: string }) {
  const fallback = FALLBACK.replace(A, hash);
  const url = useBlobObjectUrl(
    `atomic:blob:${hash}`,
    fallback,
    'image/png',
    DRIVE,
  );

  return <img src={url} alt={`Native file ${hash}`} />;
}

async function advance(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  localStorage.clear();
});

afterEach(() => {
  cleanup();
  for (const dispose of disposers.splice(0)) dispose();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

it('refreshes the same native preview after a late file event during its failure cooldown', async () => {
  const f = fixture();
  const image = screen.getByRole('img', { name: `Native file ${A}` });
  expect(f.store.getClientDb()).toBeUndefined();
  await advance(5_500);
  expect(f.deps.account).toHaveBeenCalledOnce();
  const signal = f.deps.peers.mock.calls[0][3];

  // A different file arriving must not restart or pause the first recovery.
  await act(async () => f.notify(B));
  expect(image.getAttribute('src')).toBeNull();
  expect(f.deps.peers).toHaveBeenCalledOnce();
  expect(signal.aborted).toBe(false);

  await advance(25_000);
  expect(image.getAttribute('src')).toBe(FALLBACK);
  expect(signal.aborted).toBe(true);
  expect(f.deps.credentials).not.toHaveBeenCalled();
  await act(async () => f.notify(B));
  await advance(200);
  expect(image.getAttribute('src')).toBe(FALLBACK);
  expect(f.deps.peers).toHaveBeenCalledOnce();

  f.state.local.add(A);
  await act(async () => f.notify(A));
  await advance(200);
  expect(screen.getByRole('img', { name: `Native file ${A}` })).toBe(image);
  const refreshed = new URL(image.getAttribute('src')!);
  expect(refreshed.searchParams.get('_atomic_file_recovery')).toMatch(/^\d+$/);
  refreshed.searchParams.delete('_atomic_file_recovery');
  expect(refreshed.href).toBe(FALLBACK);
  expect(f.deps.account).toHaveBeenCalledOnce();
  expect(f.deps.repair).not.toHaveBeenCalled();
});

it('ignores native file events after the recovery service is disposed', async () => {
  const f = fixture();
  await advance(30_500);
  const image = screen.getByRole('img', { name: `Native file ${A}` });
  expect(image.getAttribute('src')).toBe(FALLBACK);
  await act(async () => f.dispose());
  await advance(200);
  const scans = f.db.vaultFileHashes.mock.calls.length;
  f.state.local.add(A);
  await act(async () => f.notify(A));
  await advance(200);
  expect(image.getAttribute('src')).toBe(FALLBACK);
  expect(f.db.vaultFileHashes).toHaveBeenCalledTimes(scans);
  expect(f.unsubscribe).toHaveBeenCalledOnce();
});

it('refreshes a timed-out preview while another file is still waiting for Vault', async () => {
  const f = fixture();
  await advance(30_500);
  const image = screen.getByRole('img', { name: `Native file ${A}` });
  expect(image.getAttribute('src')).toBe(FALLBACK);

  f.state.refs.push(B);
  f.deps.account.mockResolvedValue('native@example.com');
  await act(async () => {
    f.view.rerender(
      <StoreContext.Provider value={f.store}>
        <NativePreview />
        <NativePreview hash={B} />
      </StoreContext.Provider>,
    );
  });
  await advance(5_500);
  expect(f.deps.repair).toHaveBeenCalledOnce();
  const pendingRepair = f.deps.repair.mock.calls[0][0];
  expect(pendingRepair.hashes).toEqual([B]);
  expect(pendingRepair.signal?.aborted).toBe(false);

  f.state.local.add(A);
  await act(async () => f.notify(A));
  await advance(200);
  expect(screen.getByRole('img', { name: `Native file ${A}` })).toBe(image);
  expect(image.getAttribute('src')).toContain('_atomic_file_recovery=');
  expect(
    screen.getByRole('img', { name: `Native file ${B}` }).getAttribute('src'),
  ).toBeNull();
  expect(pendingRepair.signal?.aborted).toBe(false);
  expect(f.deps.repair).toHaveBeenCalledOnce();
});

it.each(['drive', 'agent'] as const)(
  'ignores an in-flight native presence response after the %s changes',
  async scope => {
    const f = fixture();
    await advance(30_500);
    const image = screen.getByRole('img', { name: `Native file ${A}` });
    expect(image.getAttribute('src')).toBe(FALLBACK);

    let finishPresence!: (present: boolean) => void;
    f.db.vaultBlobPresent.mockImplementationOnce(
      () =>
        new Promise<boolean>(resolve => {
          finishPresence = resolve;
        }),
    );
    await act(async () => f.notify(A));
    await advance(200);
    expect(finishPresence).toBeTypeOf('function');
    await act(async () => {
      if (scope === 'drive') f.source.setDrive('atomic:other-drive');
      else
        f.source.setAgent({ subject: 'atomic:agent:native-bob' } as Parameters<
          SourceStore['setAgent']
        >[0]);
    });
    await act(async () => finishPresence(true));
    await advance(200);
    expect(image.getAttribute('src') ?? '').not.toContain(
      '_atomic_file_recovery',
    );
    expect(f.deps.repair).not.toHaveBeenCalled();
  },
);
