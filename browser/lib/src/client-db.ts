/**
 * ClientDbWorker: typed async wrapper around the WASM ClientDb.
 *
 * Multi-tab strategy: **leader-owns-DB + BroadcastChannel fanout**.
 *
 * - Every tab constructs a `ClientDbWorker`. Each tab `navigator.locks.request`s
 *   the `atomic-db-leader` lock.
 * - One tab gets the lock — it becomes the **leader**. The leader spawns a
 *   dedicated worker, opens the OPFS handle, and answers DB calls locally.
 * - Other tabs are **followers**. They forward every DB call over a
 *   `BroadcastChannel` to the leader and await a response tagged by their
 *   tab id + request id.
 * - When the leader tab closes, its lock releases; a waiting follower's lock
 *   callback fires and it promotes itself to leader.
 *
 * Why not SharedWorker: Firefox/Safari don't expose `createSyncAccessHandle`
 * in SharedWorker, and Playwright's headless Chromium doesn't expose
 * `Worker` inside SharedWorker scope. Plain DedicatedWorker + navigator.locks
 * works in every evergreen browser and every automation runner.
 *
 * Usage:
 * ```ts
 * const clientDb = new ClientDbWorker('/wasm/atomic_wasm.js', '/wasm/client-db-worker.js');
 * await clientDb.init('https://myserver.com');
 * ```
 */

import type { WorkerRequest, WorkerResponse } from './client-db.worker.js';

export interface ClientDbQueryResult {
  subjects: string[];
  resources: string[];
  count: number;
}

export interface ClientDbQueryOpts {
  property?: string;
  value?: string;
  sortBy?: string;
  sortDesc?: boolean;
  limit?: number;
  offset?: number;
  includeResources?: boolean;
  /** Drive scope — required for sorted queries. */
  drive?: string;
}

type PendingRequest = {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
};

const LEADER_LOCK = 'atomic-db-leader';
const RPC_CHANNEL = 'atomic-db-rpc';

/**
 * `'failed'` means leader election timed out: the lock is held by a stale tab
 * that isn't answering `leader-ping`, so we have no leader and aren't the
 * leader either. We park here, fail RPCs fast, and recover automatically if
 * the lock becomes acquirable later (`becomeLeader` flips us back to
 * `'leader'`) or another tab's `leader-announce` reaches us (handler flips us
 * to `'follower'`).
 */
type Role = 'initializing' | 'leader' | 'follower' | 'failed';

const LEADERSHIP_TIMEOUT_MS = 5000;

type BroadcastMessage =
  | { type: 'leader-ping' }
  | { type: 'leader-announce' }
  | {
      type: 'rpc-req';
      fromTab: string;
      id: string;
      payload: Record<string, unknown>;
    }
  | {
      type: 'rpc-res';
      toTab: string;
      id: string;
      ok: true;
      data: unknown;
    }
  | {
      type: 'rpc-res';
      toTab: string;
      id: string;
      ok: false;
      error: string;
    };

export class ClientDbWorker {
  private worker: Worker | null = null;
  private bc: BroadcastChannel | null = null;
  private role: Role = 'initializing';
  private tabId = (crypto as Crypto & { randomUUID?: () => string }).randomUUID
    ? crypto.randomUUID()
    : Math.random().toString(36).slice(2);
  private nextId = 1;
  private pending = new Map<string, PendingRequest>();
  private workerUrl: string;
  private wasmUrl: string;
  private ready = false;
  private seeded = true;
  private initPromise: Promise<void> | null = null;
  private seedPromise: Promise<void> | null = null;
  private _initError: Error | undefined = undefined;
  /** Resolved when we become leader (own the DB locally). */
  private onBecameLeader!: () => void;
  private leadershipGained: Promise<void>;
  /** Resolved when we observe an announce from another leader tab. */
  private onObservedLeader!: () => void;
  private leaderObserved: Promise<void>;

  get initError(): Error | undefined {
    return this._initError;
  }

  constructor(wasmUrl: string, workerUrl?: string) {
    this.wasmUrl = wasmUrl;
    this.workerUrl = workerUrl ?? '';
    this.leadershipGained = new Promise<void>(r => {
      this.onBecameLeader = r;
    });
    this.leaderObserved = new Promise<void>(r => {
      this.onObservedLeader = r;
    });
  }

  async init(baseUrl?: string): Promise<void> {
    if (this.initPromise) return this.initPromise;
    this.initPromise = this.doInit(baseUrl);

    return this.initPromise;
  }

  private async doInit(baseUrl?: string): Promise<void> {
    if (!this.workerUrl) {
      throw new Error(
        'ClientDbWorker requires a workerUrl. Pass the URL to client-db-worker.js.',
      );
    }

    this.bc = new BroadcastChannel(RPC_CHANNEL);
    this.bc.onmessage = (event: MessageEvent<BroadcastMessage>) =>
      this.handleBroadcast(event.data);

    // Bid for leadership. `navigator.locks.request` queues this if another tab
    // already holds the lock; our callback only fires when we own it (either
    // immediately or after the current leader's tab closes).
    //
    // We deliberately do NOT await this request — we let it run forever. The
    // callback holds the lock until the tab closes by returning a promise
    // that never resolves.
    void navigator.locks
      .request(LEADER_LOCK, { mode: 'exclusive' }, async () => {
        try {
          await this.becomeLeader(baseUrl);
        } catch (e) {
          this._initError = e instanceof Error ? e : new Error(String(e));
          // Release the lock so another tab can try.
          throw e;
        }

        return new Promise<void>(() => {
          // Hold the lock for the lifetime of this tab. Never resolve.
          // When the tab unloads, the browser reaps this promise + releases
          // the lock, and one of the queued followers is promoted.
        });
      })
      .catch(e => {
        // Typically only rejects if the callback throws.
        this._initError = e instanceof Error ? e : new Error(String(e));
      });

    // Ping any existing leader so it can announce itself. The announce also
    // fires unprompted when a tab first becomes leader, so this is mainly for
    // the case where we open AFTER the leader announced.
    this.bc.postMessage({ type: 'leader-ping' } satisfies BroadcastMessage);

    // Wait until we either become leader, hear from one, or time out.
    // The timeout matters when a previous tab on this origin is holding the
    // OPFS lock without responding to `leader-ping` (e.g. its bundle was
    // broken from a stale dev-server cache). Without the timeout, every
    // `await initPromise` and `clientDb.send()` deadlocks the rest of the
    // app — symptom: "Syncing…" / "Initializing" / resources stuck loading.
    const winner = await Promise.race([
      this.leadershipGained.then(() => 'leader' as const),
      this.leaderObserved.then(() => 'follower' as const),
      new Promise<'timeout'>(resolve =>
        setTimeout(() => resolve('timeout'), LEADERSHIP_TIMEOUT_MS),
      ),
    ]);

    if (winner === 'timeout') {
      this.role = 'failed';
      this._initError = new Error(
        `ClientDb leadership election timed out after ${LEADERSHIP_TIMEOUT_MS}ms. A stale tab on this origin is holding the OPFS lock without responding to leader-ping. Close it (or all tabs of this origin) and reload.`,
      );
      console.warn('[ClientDb]', this._initError.message);
      return;
    }

    this.ready = true;
  }

  /**
   * Called when our `navigator.locks.request` callback fires. Spawn the
   * worker, init WASM, take ownership of OPFS, and start serving follower
   * RPCs.
   */
  private async becomeLeader(baseUrl?: string): Promise<void> {
    this.worker = new Worker(this.workerUrl, { type: 'module' });
    this.worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
      const { id, type, ...rest } = event.data;
      const pending = this.pending.get(String(id));
      if (!pending) return;
      this.pending.delete(String(id));
      if (type === 'error') {
        pending.reject(new Error((rest as { message: string }).message));
      } else {
        pending.resolve((rest as { data?: unknown }).data);
      }
    };
    this.worker.onerror = (event: ErrorEvent) => {
      console.error('[ClientDb Worker Error]', event.message);
    };

    await this.sendToWorker({
      type: 'init',
      wasmUrl: this.wasmUrl,
      baseUrl,
    });

    this.role = 'leader';
    // Recover from a prior `'failed'` (leadership-timeout) state if the lock
    // finally became acquirable: clear the init error, mark ready, and let
    // `waitForReady` resolve true on subsequent calls.
    this._initError = undefined;
    this.ready = true;
    this.onBecameLeader();
    this.bc?.postMessage({
      type: 'leader-announce',
    } satisfies BroadcastMessage);
  }

  private handleBroadcast(msg: BroadcastMessage): void {
    switch (msg.type) {
      case 'leader-ping':
        if (this.role === 'leader') {
          this.bc?.postMessage({
            type: 'leader-announce',
          } satisfies BroadcastMessage);
        }
        break;

      case 'leader-announce':
        if (this.role !== 'leader') {
          // Recover from a prior `'failed'` state if a leader finally
          // announces itself (the stale tab woke up, or a fresh tab took
          // leadership). Clearing initError + ready=true lets cached
          // `waitForReady` callers proceed.
          if (this.role === 'failed') {
            this._initError = undefined;
            this.ready = true;
          }
          this.role = 'follower';
          this.onObservedLeader();
        }
        break;

      case 'rpc-req':
        if (this.role !== 'leader') return;
        // A follower sent us a DB call. Forward to our worker and broadcast
        // the result back keyed by the requester's tab id.
        this.sendToWorker(msg.payload as Record<string, unknown>).then(
          data => {
            this.bc?.postMessage({
              type: 'rpc-res',
              toTab: msg.fromTab,
              id: msg.id,
              ok: true,
              data,
            } satisfies BroadcastMessage);
          },
          err => {
            this.bc?.postMessage({
              type: 'rpc-res',
              toTab: msg.fromTab,
              id: msg.id,
              ok: false,
              error: err instanceof Error ? err.message : String(err),
            } satisfies BroadcastMessage);
          },
        );
        break;

      case 'rpc-res':
        if (msg.toTab !== this.tabId) return;
        {
          const pending = this.pending.get(msg.id);
          if (!pending) return;
          this.pending.delete(msg.id);
          if (msg.ok) pending.resolve(msg.data);
          else pending.reject(new Error(msg.error));
        }
        break;
    }
  }

  /* ------------------------------- Public API ------------------------------ */

  async getResource(subject: string): Promise<string | null> {
    const r = await this.send({ type: 'getResource', subject });

    return (r as string | null) ?? null;
  }

  /**
   * Combined cold-load fetch: returns both the resource's JSON-AD and
   * its Loro snapshot in a single worker round-trip. Halves the
   * postMessage traffic for the cold-load path (every mounted
   * `useResource` calls `fetchResourceWithLocalFallback`, which used to
   * do two sequential `await`s here).
   */
  async getResourceWithSnapshot(
    subject: string,
  ): Promise<{ jsonAd: string | null; snapshot: Uint8Array | null }> {
    const r = (await this.send({
      type: 'getResourceWithSnapshot',
      subject,
    })) as { jsonAd: string | null; snapshot: Uint8Array | null } | null;

    return r ?? { jsonAd: null, snapshot: null };
  }

  async putResource(jsonAd: string): Promise<void> {
    await this.send({ type: 'putResource', jsonAd });
  }

  /** Put many resources in a single worker round-trip. The worker
   *  processes them in order — caller-side ordering is preserved — but
   *  the postMessage overhead amortises to ~one round-trip total
   *  instead of N. Used by the bootstrap seed loop (70 properties
   *  used to mean 70 sequential round-trips). */
  async putResources(jsonAds: string[]): Promise<void> {
    if (jsonAds.length === 0) return;
    await this.send({ type: 'putResources', jsonAds });
  }

  async applyCommit(commitJsonAd: string): Promise<void> {
    await this.send({ type: 'applyCommit', commitJsonAd });
  }

  async removeResource(subject: string): Promise<void> {
    await this.send({ type: 'removeResource', subject });
  }

  async query(opts: ClientDbQueryOpts = {}): Promise<ClientDbQueryResult> {
    const r = await this.send({ type: 'query', ...opts });

    return r as ClientDbQueryResult;
  }

  async allSubjects(): Promise<string[]> {
    const r = await this.send({ type: 'allSubjects' });

    return r as string[];
  }

  async populate(): Promise<void> {
    await this.send({ type: 'populate' });
  }

  async exportAllResources(): Promise<string> {
    const r = await this.send({ type: 'exportAllResources' });

    return r as string;
  }

  async importAllResources(jsonArray: string): Promise<number> {
    const r = await this.send({ type: 'importAllResources', jsonArray });

    return r as number;
  }

  async putLoroSnapshot(subject: string, data: Uint8Array): Promise<void> {
    await this.send({ type: 'putLoroSnapshot', subject, data });
  }

  async getLoroSnapshot(subject: string): Promise<Uint8Array | null> {
    const r = await this.send({ type: 'getLoroSnapshot', subject });

    return (r as Uint8Array | null) ?? null;
  }

  async putBlob(hash: Uint8Array, data: Uint8Array): Promise<void> {
    await this.send({ type: 'putBlob', hash, data });
  }

  async getBlob(hash: Uint8Array): Promise<Uint8Array | null> {
    const r = await this.send({ type: 'getBlob', hash });

    return (r as Uint8Array | null) ?? null;
  }

  async blake3Hash(data: Uint8Array): Promise<Uint8Array> {
    const r = await this.send({ type: 'blake3Hash', data });

    return r as Uint8Array;
  }

  async getAllVersionVectors(): Promise<
    Record<string, Record<string, number>>
  > {
    const r = await this.send({ type: 'getAllVersionVectors' });

    return (r as Record<string, Record<string, number>>) ?? {};
  }

  get isReady(): boolean {
    return this.ready && this.seeded;
  }

  /** True once the WASM worker is initialized — independent of the
   *  bootstrap seed. Lookups for resources that aren't part of the
   *  bootstrap (i.e. user data) only need this; gating them on the seed
   *  blocks every cold-load useResource on a few hundred milliseconds
   *  of property puts they don't even depend on. */
  get isInitialized(): boolean {
    return this.ready;
  }

  setSeedPromise(promise: Promise<void>): void {
    this.seeded = false;
    this.seedPromise = promise.then(() => {
      this.seeded = true;
    });
  }

  /** Resolves when the WASM worker is initialized (lookups can run).
   *  Does NOT wait for the bootstrap seed — see {@link waitForReady}. */
  async waitForInit(): Promise<boolean> {
    if (this.ready) return true;
    if (!this.initPromise) return false;
    try {
      await this.initPromise;

      return this.ready;
    } catch {
      return false;
    }
  }

  async waitForReady(): Promise<boolean> {
    if (this.ready && this.seeded) return true;
    if (!this.initPromise) return false;
    try {
      await this.initPromise;
      if (this.seedPromise) await this.seedPromise;

      return this.ready && this.seeded;
    } catch {
      return false;
    }
  }

  destroy(): void {
    this.bc?.close();
    this.worker?.terminate();
    this.bc = null;
    this.worker = null;
    this.ready = false;
    this.seeded = true;
    this.initPromise = null;
    this.seedPromise = null;
    for (const [, pending] of this.pending) {
      pending.reject(new Error('ClientDb worker destroyed'));
    }
    this.pending.clear();
  }

  /* ---------------------------- Internal send ----------------------------- */

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async send(msg: Record<string, any>): Promise<unknown> {
    // Websocket fanout can call into the DB before init() has resolved
    // (leadership election + leader announce takes a few ticks). Wait for
    // init rather than rejecting — the caller already started init, we just
    // need to let it finish.
    if (this.role === 'initializing' && this.initPromise) {
      await this.initPromise;
    }

    if (this.role === 'leader') {
      return this.sendToWorker(msg);
    }

    if (this.role === 'follower') {
      return this.sendToLeader(msg);
    }

    if (this.role === 'failed') {
      // Leadership election timed out and we're parked. Fail fast so callers
      // like `computeDriveSyncState` and `useChildren` proceed in degraded
      // mode (in-memory only) instead of awaiting forever.
      throw new Error(
        `ClientDb unavailable: ${this._initError?.message ?? 'init failed'}`,
      );
    }

    throw new Error('ClientDbWorker send() called before init() completed');
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private sendToWorker(msg: Record<string, any>): Promise<unknown> {
    if (!this.worker) {
      return Promise.reject(new Error('ClientDb worker not initialized'));
    }
    const id = String(this.nextId++);

    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.worker!.postMessage({ ...msg, id } as unknown as WorkerRequest);
    });
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private sendToLeader(msg: Record<string, any>): Promise<unknown> {
    if (!this.bc) {
      return Promise.reject(
        new Error('ClientDb BroadcastChannel not initialized'),
      );
    }
    const id = String(this.nextId++);

    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.bc!.postMessage({
        type: 'rpc-req',
        fromTab: this.tabId,
        id,
        payload: msg,
      } satisfies BroadcastMessage);
    });
  }
}
