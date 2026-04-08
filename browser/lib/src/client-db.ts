/**
 * ClientDbWorker: typed async wrapper around the WASM ClientDb Web Worker.
 *
 * Usage:
 * ```ts
 * const clientDb = new ClientDbWorker('/path/to/atomic_wasm.js');
 * await clientDb.init('https://myserver.com');
 *
 * await clientDb.putResource(jsonAdString);
 * const result = await clientDb.query({ property: 'https://atomicdata.dev/properties/isA', value: 'https://atomicdata.dev/classes/Agent' });
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

export class ClientDbWorker {
  private worker: Worker | null = null;
  private nextId = 1;
  private pending = new Map<number, PendingRequest>();
  private workerUrl: string;
  private wasmUrl: string;
  private ready = false;
  private initPromise: Promise<void> | null = null;

  /**
   * @param wasmUrl - URL to the atomic_wasm.js glue module (e.g. '/wasm/atomic_wasm.js')
   * @param workerUrl - URL to the compiled worker script. If not provided, the worker
   *   will be created from a blob URL using the built-in worker code.
   */
  constructor(wasmUrl: string, workerUrl?: string) {
    this.wasmUrl = wasmUrl;
    this.workerUrl = workerUrl ?? '';
  }

  /** Initialize the worker and WASM module. Call once before using other methods. */
  async init(baseUrl?: string): Promise<void> {
    if (this.initPromise) {
      return this.initPromise;
    }

    this.initPromise = this.doInit(baseUrl);

    return this.initPromise;
  }

  private async doInit(baseUrl?: string): Promise<void> {
    if (this.workerUrl) {
      this.worker = new Worker(this.workerUrl, { type: 'module' });
    } else {
      throw new Error(
        'ClientDbWorker requires a workerUrl. ' +
          'Pass the URL to the compiled client-db.worker.js file.',
      );
    }

    this.worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
      const { id, type, ...rest } = event.data;
      const pending = this.pending.get(id);

      if (!pending) return;

      this.pending.delete(id);

      if (type === 'error') {
        pending.reject(new Error((rest as { message: string }).message));
      } else {
        pending.resolve((rest as { data?: unknown }).data);
      }
    };

    this.worker.onerror = (event: ErrorEvent) => {
      console.error('[ClientDb Worker Error]', event.message);
    };

    await this.send({ type: 'init', wasmUrl: this.wasmUrl, baseUrl });
    this.ready = true;
  }

  /** Get a resource by subject. Returns JSON-AD string or null. */
  async getResource(subject: string): Promise<string | null> {
    const result = await this.send({ type: 'getResource', subject });

    return (result as string | null) ?? null;
  }

  /** Store a resource from a JSON-AD string. Used for initial bulk sync. */
  async putResource(jsonAd: string): Promise<void> {
    await this.send({ type: 'putResource', jsonAd });
  }

  /**
   * Apply a Commit (JSON-AD) to the local database.
   * Efficient incremental path: only updates index entries for changed properties.
   * Use for real-time COMMIT messages from the WebSocket.
   */
  async applyCommit(commitJsonAd: string): Promise<void> {
    await this.send({ type: 'applyCommit', commitJsonAd });
  }

  /** Remove a resource by subject. */
  async removeResource(subject: string): Promise<void> {
    await this.send({ type: 'removeResource', subject });
  }

  /** Query the local database. */
  async query(opts: ClientDbQueryOpts = {}): Promise<ClientDbQueryResult> {
    const result = await this.send({
      type: 'query',
      ...opts,
    });

    return result as ClientDbQueryResult;
  }

  /** Get all subjects in the database. */
  async allSubjects(): Promise<string[]> {
    const result = await this.send({ type: 'allSubjects' });

    return result as string[];
  }

  /** Populate with default Atomic Data vocabulary. */
  async populate(): Promise<void> {
    await this.send({ type: 'populate' });
  }

  /** Export all resources as a JSON array string. For snapshotting to IndexedDB. */
  async exportAllResources(): Promise<string> {
    const result = await this.send({ type: 'exportAllResources' });

    return result as string;
  }

  /** Import resources from a JSON array string. For restoring from IndexedDB. Returns count. */
  async importAllResources(jsonArray: string): Promise<number> {
    const result = await this.send({ type: 'importAllResources', jsonArray });

    return result as number;
  }

  /** Whether the worker has been initialized. */
  get isReady(): boolean {
    return this.ready;
  }

  /** Wait for the WASM DB to finish initializing. Resolves immediately if already ready. */
  async waitForReady(): Promise<boolean> {
    if (this.ready) return true;
    if (!this.initPromise) return false;

    try {
      await this.initPromise;

      return this.ready;
    } catch {
      return false;
    }
  }

  /** Terminate the worker. */
  destroy(): void {
    this.worker?.terminate();
    this.worker = null;
    this.ready = false;
    this.initPromise = null;

    // Reject all pending requests
    for (const [, pending] of this.pending) {
      pending.reject(new Error('ClientDb worker destroyed'));
    }

    this.pending.clear();
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private send(msg: Record<string, any>): Promise<unknown> {
    if (!this.worker) {
      return Promise.reject(new Error('ClientDb worker not initialized'));
    }

    const id = this.nextId++;

    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.worker!.postMessage({ ...msg, id } as WorkerRequest);
    });
  }
}
