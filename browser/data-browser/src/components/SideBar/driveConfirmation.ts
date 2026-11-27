import { confirmDriveCopy } from '../../helpers/confirmDriveCopy';
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
    if (!drive || !agent?.subject) return;
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
      this.eligible();
    let success = false;

    try {
      success =
        (await confirmDriveCopy(
          store,
          drive,
          server,
          agent,
          controller.signal,
          current,
        )) === true;

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
