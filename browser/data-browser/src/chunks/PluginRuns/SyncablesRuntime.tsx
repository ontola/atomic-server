import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useSyncExternalStore,
  type PropsWithChildren,
} from 'react';
import {
  canonicalizeScheme,
  StoreEvents,
  useCurrentAgent,
  useServerURL,
  useStore,
} from '@tomic/react';
import {
  getIntegrationProxy,
  useIntegrationProxy,
} from '@helpers/integrationProxy';
import { ProxyConnections } from '@helpers/proxyConnections';
import { SyncablesFrame } from './SyncablesFrame';
import { syncablesHostRequest, type SyncablesDiscovery } from './syncablesHost';

export interface SyncablesRun {
  readonly id: number;
  readonly drive: string;
  readonly table: string;
  readonly controller: AbortController;
  source?: string;
}

/** Only source fields participate. Status and presentation can change during a run. */
export function syncablesSourceSignature(context: unknown): string {
  const source = context as Record<string, unknown> | null;
  if (
    !source ||
    source.kind !== 'mirror' ||
    source.platform !== 'github-issues'
  )
    throw new Error('Select an Issues mirror to sync');

  return JSON.stringify([
    source.platform,
    source.proxyOrigin,
    source.mode,
    source.connectionId,
    source.ownerId,
    source.ownerLogin,
    source.repoId,
    source.repoName,
  ]);
}

const runKey = (drive: string, table: string) =>
  JSON.stringify([canonicalizeScheme(drive), canonicalizeScheme(table)]);

/** The app owns runs, so changing the visible resource does not discard a sync. */
export class SyncablesRunRegistry {
  private entries = new Map<string, SyncablesRun>();
  private pending = new Map<string, Promise<void>>();
  private listeners = new Set<() => void>();
  private snapshot: SyncablesRun[] = [];
  private sequence = 0;

  constructor(
    private source: (
      drive: string,
      table: string,
      signal: AbortSignal,
    ) => Promise<string>,
    private current: () => boolean,
  ) {}

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);

    return () => {
      this.listeners.delete(listener);
    };
  };

  getSnapshot = () => this.snapshot;

  private publish() {
    this.snapshot = [...this.entries.values()].filter(
      run => run.source !== undefined,
    );
    for (const listener of this.listeners) listener();
  }

  isRunning = (drive: string, table: string): boolean =>
    this.entries.has(runKey(drive, table));

  start = (drive: string, table: string): Promise<void> => {
    const key = runKey(drive, table);
    if (this.entries.has(key))
      return this.pending.get(key) ?? Promise.resolve();
    if (!this.current())
      return Promise.reject(new Error('Sign in to start sync'));
    const run: SyncablesRun = {
      id: ++this.sequence,
      drive,
      table,
      controller: new AbortController(),
    };
    this.entries.set(key, run);
    const ready = this.source(drive, table, run.controller.signal)
      .then(source => {
        run.controller.signal.throwIfAborted();
        if (!this.current())
          throw new Error('The sync account or server changed');
        run.source = source;
        this.publish();
      })
      .catch(reason => {
        this.finish(run);
        throw reason;
      })
      .finally(() => {
        if (this.pending.get(key) === ready) this.pending.delete(key);
      });
    this.pending.set(key, ready);

    return ready;
  };

  assertActive(run: SyncablesRun, context: unknown): void {
    run.controller.signal.throwIfAborted();
    let signature: string;

    try {
      signature = syncablesSourceSignature(context);
    } catch (reason) {
      this.finish(run);
      throw reason;
    }

    if (
      this.entries.get(runKey(run.drive, run.table)) !== run ||
      !this.current() ||
      run.source !== signature
    ) {
      this.finish(run);
      throw new Error('The sync source, account, or server changed');
    }
  }

  finish = (run: SyncablesRun): void => {
    const key = runKey(run.drive, run.table);
    if (this.entries.get(key) !== run) return;
    this.entries.delete(key);
    this.pending.delete(key);
    run.controller.abort();
    this.publish();
  };

  cancel = (drive: string, table: string): void => {
    const run = this.entries.get(runKey(drive, table));
    if (run) this.finish(run);
  };

  clear = (): void => {
    for (const run of [...this.entries.values()]) this.finish(run);
  };
}

const RuntimeContext = createContext<SyncablesRunRegistry | undefined>(
  undefined,
);

export const useSyncablesRuntime = () => useContext(RuntimeContext);

function discovery(): SyncablesDiscovery {
  return {
    owners: new Set(),
    repositories: new Map(),
    publicIssuePages: new Map(),
  };
}

export function SyncablesRuntimeProvider({ children }: PropsWithChildren) {
  const store = useStore();
  const [actor] = useCurrentAgent();
  const [server] = useServerURL();
  const origin = useIntegrationProxy();
  const runtime = useMemo(() => {
    const current = () =>
      !!actor?.subject &&
      store.getAgent() === actor &&
      store.getServerUrl() === server &&
      getIntegrationProxy() === origin;
    const proxy = new ProxyConnections(localStorage, origin, () =>
      store.getAgent(),
    );

    return new SyncablesRunRegistry(async (drive, table, signal) => {
      if (store.noServer)
        throw new Error('Sync requires an Atomic Server node');
      const source = await syncablesHostRequest(
        store,
        drive,
        table,
        { op: 'syncablesContext' },
        proxy,
        discovery(),
        signal,
      );
      const signature = syncablesSourceSignature(source);
      const resource = await store.getResource(table);
      const [canWrite] = await resource.canWrite(actor?.subject);
      if (!canWrite)
        throw new Error('Write access to this Issues table is required');
      const status = (await syncablesHostRequest(
        store,
        drive,
        table,
        { op: 'syncablesMirrorStatus' },
        proxy,
        discovery(),
        signal,
      )) as { paused: boolean };
      if (status.paused) throw new Error('Resume this mirror before syncing');

      return signature;
    }, current);
  }, [store, actor, server, origin]);
  const runs = useSyncExternalStore(
    runtime.subscribe,
    runtime.getSnapshot,
    runtime.getSnapshot,
  );

  useEffect(() => {
    const unbind = [
      store.on(StoreEvents.AgentChanged, runtime.clear),
      store.on(StoreEvents.ServerURLChanged, runtime.clear),
    ];

    return () => {
      for (const remove of unbind) remove();
      runtime.clear();
    };
  }, [store, runtime]);

  return (
    <RuntimeContext.Provider value={runtime}>
      {children}
      {runs.map(run => (
        <SyncablesFrame
          key={run.id}
          drive={run.drive}
          table={run.table}
          presentation='worker'
          worker={run}
        />
      ))}
    </RuntimeContext.Provider>
  );
}
