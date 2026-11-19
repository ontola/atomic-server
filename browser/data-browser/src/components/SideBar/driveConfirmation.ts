import { signRequest } from '@tomic/lib';
import type { Store } from '@tomic/react';

/** Read-only proof of the current drive on the current server. A stale response
 * never survives an edit, a connection change, or an identity/drive switch. */
export class DriveConfirmation {
  private generation = 0;
  private confirmed = false;
  private running = false;
  private stopped = false;
  private abort?: AbortController;
  private timer?: ReturnType<typeof setTimeout>;
  private retryMs = 2_000;
  private lastAttempt = 0;

  constructor(
    private store: Store,
    private eligible: () => boolean,
    private changed: (confirmed: boolean) => void,
  ) {}

  public invalidate(): void {
    this.generation++;
    this.abort?.abort();
    this.abort = undefined;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.running = false;

    if (this.confirmed) {
      this.confirmed = false;
      if (!this.stopped) this.changed(false);
    }
  }

  public update(): void {
    if (
      this.stopped ||
      this.confirmed ||
      this.running ||
      this.timer ||
      !this.eligible()
    )
      return;
    const delay = Math.max(750, this.lastAttempt + 5_000 - Date.now());
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.check();
    }, delay);
  }

  public close(): void {
    this.stopped = true;
    this.invalidate();
  }

  private async check(): Promise<void> {
    if (!this.eligible() || this.stopped) return;
    const generation = this.generation;
    const store = this.store;
    const drive = store.getDrive();
    const agent = store.getAgent();
    const server = store.getServerUrl();
    const db = store.getClientDb();
    if (
      !drive ||
      !agent?.subject ||
      !db?.isReady ||
      db.initError ||
      typeof db.flush !== 'function' ||
      typeof db.getVersionVectorsForDrive !== 'function'
    )
      return;
    const normalized = store.normalizeSubject(drive);
    const identity = agent.subject;
    const controller = new AbortController();
    this.abort = controller;
    this.running = true;
    this.lastAttempt = Date.now();
    const timeout = setTimeout(() => controller.abort(), 10_000);
    const current = () =>
      !this.stopped &&
      !controller.signal.aborted &&
      generation === this.generation &&
      store.getDrive() === drive &&
      store.getServerUrl() === server &&
      store.getAgent()?.subject === identity &&
      store.getClientDb() === db &&
      db.isReady &&
      !db.initError &&
      this.eligible();
    let success = false;

    try {
      await db.flush();
      if (!current() || !db.isReady || db.initError) return;
      const state = await store.computeDriveSyncState(normalized, {
        sparse: true,
      });
      if (
        !current() ||
        state.hashVersion !== 2 ||
        !state.vvs ||
        !/^[0-9a-f]{64}$/.test(state.driveHash)
      )
        return;
      const url = new URL('/drive-sync-confirmation', server);
      url.searchParams.set('subject', normalized);
      url.searchParams.set('hash', state.driveHash);
      url.searchParams.set('hashVersion', '2');
      const headers = await signRequest(url.toString(), agent, {
        Accept: 'application/json',
      });
      if (!current()) return;
      const response = await fetch(url.toString(), {
        headers,
        cache: 'no-store',
        redirect: 'error',
        signal: controller.signal,
      });
      if (!response.ok || !current()) return;
      const data: unknown = await response.json();
      if (!current() || !data || typeof data !== 'object') return;
      const result = data as Record<string, unknown>;
      success =
        result.version === 1 &&
        result.drive === normalized &&
        result.hashVersion === 2 &&
        result.driveHash === state.driveHash &&
        result.confirmed === true &&
        Number.isSafeInteger(result.checkedBlobs) &&
        (result.checkedBlobs as number) >= 0;

      if (success) {
        this.confirmed = true;
        this.retryMs = 2_000;
        this.changed(true);
      }
    } catch {
      // Older servers, malformed replies, network failures and timeouts are unknown.
    } finally {
      clearTimeout(timeout);

      if (generation === this.generation) {
        this.abort = undefined;
        this.running = false;

        if (!success && !this.stopped && this.eligible()) {
          const delay = this.retryMs;
          this.retryMs = Math.min(this.retryMs * 2, 30_000);
          this.timer = setTimeout(() => {
            this.timer = undefined;
            this.update();
          }, delay);
        }
      }
    }
  }
}
