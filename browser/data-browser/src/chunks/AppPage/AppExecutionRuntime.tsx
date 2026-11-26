import {
  createContext,
  useContext,
  useEffect,
  useState,
  useSyncExternalStore,
  type PropsWithChildren,
} from 'react';
import {
  StoreEvents,
  useCurrentAgent,
  useServerURL,
  useStore,
} from '@tomic/react';
import { useIntegrationProxy } from '@helpers/integrationProxy';
import { AppFrame, type AppFrameProfile, type AppOutcome } from './AppFrame';

export interface AppExecutionSpec {
  app: string;
  drive: string;
  table: string;
  profile: AppFrameProfile;
  subscribe?: (cancel: () => void) => () => void;
  failed?: (message: string, signal: AbortSignal) => Promise<void>;
}
export interface AppExecutionRun {
  id: number;
  key: string;
  controller: AbortController;
  failureController?: AbortController;
  spec?: AppExecutionSpec;
  ready?: boolean;
  timer?: ReturnType<typeof setTimeout>;
  unsubscribe?: () => void;
  group?: string;
  queued?: boolean;
  prepare?: (signal: AbortSignal) => Promise<AppExecutionSpec>;
  failed?: AppExecutionSpec['failed'];
  pageProgress?: { page: number; total?: number };
}

export interface AppExecutionStartOptions {
  /** Serialize complete workers that reconcile the same storage destination. */
  group?: string;
  /** Revoke a queued job if its captured source changes before it can start. */
  subscribe?: AppExecutionSpec['subscribe'];
  failed?: AppExecutionSpec['failed'];
}

/** App execution belongs to the app shell, independent of its visible route. */
export class AppExecutionRegistry {
  private runs = new Map<string, AppExecutionRun>();
  private listeners = new Set<() => void>();
  private snapshot: AppExecutionRun[] = [];
  private sequence = 0;
  private clearing = false;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);

    return () => {
      this.listeners.delete(listener);
    };
  };
  getSnapshot = () => this.snapshot;
  private publish() {
    this.snapshot = [...this.runs.values()].filter(
      run => run.spec !== undefined && !run.controller.signal.aborted,
    );
    for (const listener of this.listeners) listener();
  }
  isRunning = (key: string) => this.runs.has(key);
  isQueued = (key: string) => this.runs.get(key)?.queued === true;
  pageProgress(key: string) {
    return this.runs.get(key)?.pageProgress;
  }
  reportPage(
    key: string,
    signal: AbortSignal,
    progress: NonNullable<AppExecutionRun['pageProgress']>,
  ) {
    const run = this.runs.get(key);
    if (run?.controller.signal === signal && !signal.aborted)
      run.pageProgress = progress;
  }
  start = async (
    key: string,
    prepare: (signal: AbortSignal) => Promise<AppExecutionSpec>,
    options: AppExecutionStartOptions = {},
  ) => {
    if (this.runs.has(key)) return;
    const run: AppExecutionRun = {
      id: ++this.sequence,
      key,
      controller: new AbortController(),
      group: options.group,
      queued: true,
      prepare,
      failed: options.failed,
    };
    this.runs.set(key, run);

    try {
      const unsubscribe = options.subscribe?.(() => this.finish(run));

      if (this.runs.get(key) !== run) {
        unsubscribe?.();

        return;
      }

      run.unsubscribe = unsubscribe;

      if (
        run.group !== undefined &&
        [...this.runs.values()].some(
          other => other !== run && other.group === run.group && !other.queued,
        )
      ) {
        this.publish();

        return;
      }

      // The bridge acknowledges accepted work, not completion of its authority
      // checks. Preparation remains cancellable and owned by this registry.
      this.publish();
      void this.begin(run);
    } catch (error) {
      this.finish(run);
      throw error;
    }
  };

  private async begin(run: AppExecutionRun) {
    if (this.runs.get(run.key) !== run || run.controller.signal.aborted) return;
    run.queued = false;

    try {
      const spec = await run.prepare!(run.controller.signal);
      run.controller.signal.throwIfAborted();
      run.spec = spec;
      const queuedUnsubscribe = run.unsubscribe;
      const activeUnsubscribe = spec.subscribe?.(() => this.finish(run));

      if (this.runs.get(run.key) !== run) {
        activeUnsubscribe?.();

        return;
      }

      run.unsubscribe = () => {
        queuedUnsubscribe?.();
        activeUnsubscribe?.();
      };

      run.timer = setTimeout(
        () =>
          this.settle(run, {
            ok: false,
            phase: 'load',
            message: 'The app did not start. Try again.',
          }),
        30_000,
      );
      this.publish();
    } catch (error) {
      if (this.runs.get(run.key) !== run || run.controller.signal.aborted)
        return;
      this.settle(run, {
        ok: false,
        phase: 'load',
        message:
          error instanceof Error
            ? error.message
            : 'The app could not be prepared',
      });
    }
  }

  private drain(group: string) {
    if (this.clearing) return;
    const runs = [...this.runs.values()].filter(run => run.group === group);
    if (runs.some(run => !run.queued)) return;
    const next = runs.find(run => run.queued);
    if (next) void this.begin(next);
  }
  ready = (key: string, signal: AbortSignal) => {
    const run = this.runs.get(key);
    signal.throwIfAborted();
    if (!run || run.controller.signal !== signal)
      throw new Error('This app execution is no longer active');
    run.ready = true;
    clearTimeout(run.timer);
  };
  private finish(run: AppExecutionRun) {
    if (this.runs.get(run.key) !== run) return;
    this.runs.delete(run.key);
    clearTimeout(run.timer);
    run.unsubscribe?.();
    run.unsubscribe = undefined;
    run.failureController?.abort();
    run.controller.abort();
    this.publish();
    if (run.group !== undefined) this.drain(run.group);
  }
  settle = (run: AppExecutionRun, outcome: AppOutcome) => {
    if (this.runs.get(run.key) !== run) return;
    if (run.failureController) return;

    const failed = run.spec?.failed ?? run.failed;

    if (outcome.ok || !failed) {
      this.finish(run);

      return;
    }

    clearTimeout(run.timer);
    const reporting = new AbortController();
    run.failureController = reporting;
    // Revoke and unmount the worker before awaiting host-only error reporting.
    run.controller.abort();
    this.publish();
    run.timer = setTimeout(() => this.finish(run), 10_000);
    void Promise.resolve()
      .then(() => failed(outcome.message, reporting.signal))
      .catch(() => undefined)
      .finally(() => this.finish(run));
  };
  cancel = (key: string) => {
    const run = this.runs.get(key);
    if (run) this.finish(run);
  };
  clear = () => {
    this.clearing = true;

    try {
      for (const run of [...this.runs.values()]) this.finish(run);
    } finally {
      this.clearing = false;
    }
  };
}

const Executions = createContext<AppExecutionRegistry | undefined>(undefined);

export function useAppExecutions() {
  return useContext(Executions);
}

export function AppExecutionProvider({ children }: PropsWithChildren) {
  const store = useStore();
  const [actor] = useCurrentAgent();
  const [server] = useServerURL();
  const proxy = useIntegrationProxy();
  const [registry] = useState(() => new AppExecutionRegistry());
  const runs = useSyncExternalStore(
    registry.subscribe,
    registry.getSnapshot,
    registry.getSnapshot,
  );
  useEffect(() => {
    const unbind = [
      store.on(StoreEvents.AgentChanged, registry.clear),
      store.on(StoreEvents.ServerURLChanged, registry.clear),
    ];

    return () => {
      for (const remove of unbind) remove();
      registry.clear();
    };
  }, [store, registry, actor, server, proxy]);

  return (
    <Executions.Provider value={registry}>
      {children}
      {runs.map(
        run =>
          run.spec && (
            <div key={run.id} hidden>
              <AppFrame
                app={run.spec.app}
                drive={run.spec.drive}
                table={run.spec.table}
                profile={run.spec.profile}
                silent
                onOutcome={outcome => registry.settle(run, outcome)}
              />
            </div>
          ),
      )}
    </Executions.Provider>
  );
}
