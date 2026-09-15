/** Content-free, opt-in diagnostics. No storage, network, or arbitrary payloads. */
export enum DiagnosticCode {
  SaveStarted = 'save-started',
  SavePersisted = 'save-persisted',
  SaveOffline = 'save-offline',
  SaveQueued = 'save-queued',
  SaveNoop = 'save-noop',
  SaveError = 'save-error',
  SaveSlow = 'save-slow',
  Connected = 'connected',
  Disconnected = 'disconnected',
  Queue = 'queue',
  QueueStalled = 'queue-stalled',
  DrainStarted = 'drain-started',
  DrainSettled = 'drain-settled',
  DrainError = 'drain-error',
}

export interface DiagnosticEvent {
  readonly elapsedMs: number;
  readonly code: DiagnosticCode;
  readonly resource?: number;
  readonly operation?: number;
  readonly pending?: number;
  readonly blocked?: number;
}

type SaveOutcome = 'persisted' | 'offline' | 'queued' | 'noop' | 'error';
const outcomes: Record<SaveOutcome, DiagnosticCode> = {
  persisted: DiagnosticCode.SavePersisted,
  offline: DiagnosticCode.SaveOffline,
  queued: DiagnosticCode.SaveQueued,
  noop: DiagnosticCode.SaveNoop,
  error: DiagnosticCode.SaveError,
};
const count = (value: number) =>
  Number.isFinite(value)
    ? Math.min(100_000, Math.max(0, Math.floor(value)))
    : 0;

/** One instance per Store. Aliases cannot link identities across recording sessions. */
export class DiagnosticRecorder {
  private events: DiagnosticEvent[] = [];
  private aliases = new WeakMap<object, number>();
  private nextAlias = 0;
  private nextOperation = 0;
  private started = 0;
  private timer: ReturnType<typeof setInterval> | undefined;
  private generation = 0;
  private saves = new Map<
    number,
    { resource: number; since: number; warned: boolean }
  >();
  private queueState = {
    pending: 0,
    blocked: 0,
    connected: false,
    since: 0,
    warned: false,
  };
  private listeners = new Set<() => void>();

  get active(): boolean {
    return this.timer !== undefined;
  }
  /** Changes only on start/clear/expiry; suitable for useSyncExternalStore. */
  get session(): number {
    return this.generation;
  }
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);

    return () => {
      this.listeners.delete(listener);
    };
  };

  start(): void {
    this.clear();
    this.started = Date.now();
    this.timer = setInterval(() => this.tick(), 10_000);
    this.generation++;
    this.changed();
  }

  clear(): void {
    if (this.timer !== undefined) clearInterval(this.timer);
    this.timer = undefined;
    this.events = [];
    this.saves.clear();
    this.aliases = new WeakMap();
    this.nextAlias = 0;
    this.nextOperation = 0;
    this.queueState = {
      pending: 0,
      blocked: 0,
      connected: false,
      since: 0,
      warned: false,
    };
    this.generation++;
    this.changed();
  }

  private changed(): void {
    for (const listener of this.listeners) {
      // Diagnostics consumers must never break a save or account switch.
      try {
        listener();
      } catch {
        /* best effort UI notification */
      }
    }
  }

  private tick(): void {
    if (!this.active) return;

    if (Date.now() - this.started >= 30 * 60_000) {
      this.clear();

      return;
    }

    this.events = this.events.filter(
      event => event.elapsedMs > Date.now() - this.started - 10 * 60_000,
    );

    for (const [operation, save] of this.saves) {
      if (!save.warned && Date.now() - save.since >= 30_000) {
        save.warned = true;
        this.push(DiagnosticCode.SaveSlow, save.resource, operation);
      }
    }

    const queue = this.queueState;

    if (
      queue.connected &&
      queue.pending > 0 &&
      !queue.warned &&
      Date.now() - queue.since >= 60_000
    ) {
      queue.warned = true;
      this.push(
        DiagnosticCode.QueueStalled,
        undefined,
        undefined,
        queue.pending,
        queue.blocked,
      );
    }
  }

  private push(
    code: DiagnosticCode,
    resource?: number,
    operation?: number,
    pending?: number,
    blocked?: number,
  ): void {
    if (!this.active) return;

    if (Date.now() - this.started >= 30 * 60_000) {
      this.clear();

      return;
    }

    // Explicit construction: never copy arbitrary objects into a report.
    this.events.push({
      elapsedMs: Math.max(0, Date.now() - this.started),
      code,
      resource,
      operation,
      pending,
      blocked,
    });
    if (this.events.length > 500) this.events.shift();
  }

  snapshot(): readonly DiagnosticEvent[] {
    this.tick();

    return this.events.map(event => ({ ...event }));
  }

  connection(connected: boolean): void {
    if (!this.active) return;
    this.push(
      connected ? DiagnosticCode.Connected : DiagnosticCode.Disconnected,
    );
    this.queue(this.queueState.pending, this.queueState.blocked, connected);
  }

  queue(pending: number, blocked: number, connected: boolean): void {
    if (!this.active) return;
    pending = count(pending);
    blocked = count(blocked);
    const previous = this.queueState;
    if (
      previous.pending === pending &&
      previous.blocked === blocked &&
      previous.connected === connected
    )
      return;
    this.queueState = {
      pending,
      blocked,
      connected,
      since: Date.now(),
      warned: false,
    };
    this.push(DiagnosticCode.Queue, undefined, undefined, pending, blocked);
  }

  beginDrain(): (failed: boolean) => void {
    if (!this.active) return () => {};
    const session = this.session;
    this.push(DiagnosticCode.DrainStarted);

    return failed => {
      if (session === this.session)
        this.push(
          failed ? DiagnosticCode.DrainError : DiagnosticCode.DrainSettled,
        );
    };
  }

  beginSave(target: object): (outcome: SaveOutcome) => void {
    if (!this.active) return () => {};
    let resource = this.aliases.get(target);

    if (resource === undefined) {
      resource = ++this.nextAlias;
      this.aliases.set(target, resource);
    }

    const operation = ++this.nextOperation;
    const session = this.session;
    // Bound unfinished operation tracking too, even if promises never settle.
    if (this.saves.size >= 500)
      this.saves.delete(this.saves.keys().next().value!);
    this.saves.set(operation, { resource, since: Date.now(), warned: false });
    this.push(DiagnosticCode.SaveStarted, resource, operation);

    return outcome => {
      if (session !== this.session || !this.saves.delete(operation)) return;
      this.push(
        Object.hasOwn(outcomes, outcome)
          ? outcomes[outcome]
          : DiagnosticCode.SaveError,
        resource,
        operation,
      );
    };
  }
}
