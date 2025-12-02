/**
 * The single chokepoint for every OPFS write.
 *
 * Before this class existed, four sites in the codebase each
 * called `clientDb.putResource` / `clientDb.putLoroSnapshot` /
 * `clientDb.putBlob` directly:
 *
 *   - `Store.addResource`              (JSON-AD only)
 *   - `Store.uploadFiles`              (blob)
 *   - `Resource.applyPendingCommitsLocally` (JSON-AD AND snapshot)
 *   - `WSClient.persistToClientDb`     (snapshot only)
 *   - `WSClient.handleBlobResponse`    (blob)
 *
 * The result was that a single WS UPDATE wrote JSON-AD via
 * `Store.addResource` and the Loro snapshot via a separate
 * `WSClient.persistToClientDb` call — two worker round-trips, no
 * shared lock, no error coupling. If the JSON-AD landed but the
 * snapshot didn't (or vice versa) the next reload saw a half-state.
 *
 * `OpfsPersistor` is the sole holder of the `ClientDbWorker`
 * reference outside the boot path. Every persistence operation
 * goes through one of its methods; the underlying worker calls
 * are private. New write paths add a method here, never a direct
 * `clientDb.put*` call elsewhere.
 *
 * Reads stay on the worker for now — they're already centralised
 * via `Store.queryLocalDb` and `Store.fetchResourceFromServer`.
 * If we ever migrate read paths through here too, the surface
 * stays small.
 */

import type { ClientDbWorker } from './client-db.js';

export class OpfsPersistor {
  private readonly db: ClientDbWorker;

  constructor(db: ClientDbWorker) {
    this.db = db;
  }

  /**
   * Atomic resource put: JSON-AD index entry + Loro snapshot land
   * in OPFS in one worker postMessage. Use this whenever you have
   * both forms — the worker's serialised queue guarantees no other
   * message interleaves between the two writes.
   *
   * Pass `snapshot: undefined` when you genuinely don't have a
   * Loro doc (e.g. a Commit resource which is JSON-AD-only); the
   * fallback writes JSON-AD only and is documented to leave the
   * snapshot key untouched.
   */
  async putResource(args: {
    subject: string;
    jsonAd: string;
    snapshot?: Uint8Array;
  }): Promise<void> {
    if (args.snapshot) {
      await this.db.putResourceWithSnapshot(
        args.subject,
        args.jsonAd,
        args.snapshot,
      );
    } else {
      await this.db.putResource(args.jsonAd);
    }
  }

  /**
   * Batch put for the bootstrap seed loop. Same atomicity contract
   * as `putResource`, but JSON-AD only — the bootstrap properties
   * don't carry Loro state.
   */
  async putResources(jsonAds: string[]): Promise<void> {
    await this.db.putResources(jsonAds);
  }

  async removeResource(subject: string): Promise<void> {
    await this.db.removeResource(subject);
  }

  async putBlob(hash: Uint8Array, data: Uint8Array): Promise<void> {
    await this.db.putBlob(hash, data);
  }

  /** Read paths still go through the underlying worker directly via
   * `Store.queryLocalDb` etc. — kept here as a thin pass-through so
   * read+write can share one persistor reference once we centralise
   * reads as well. */
  async getResourceWithSnapshot(subject: string): Promise<{
    jsonAd: string | null;
    snapshot: Uint8Array | null;
  }> {
    return this.db.getResourceWithSnapshot(subject);
  }

  async getBlob(hash: Uint8Array): Promise<Uint8Array | null> {
    return this.db.getBlob(hash);
  }

  /** Lifecycle pass-throughs so callers can keep one
   * persistor reference instead of also holding the worker. */
  get isReady(): boolean {
    return this.db.isReady;
  }

  async waitForReady(): Promise<boolean> {
    return this.db.waitForReady();
  }

  async waitForInit(): Promise<boolean> {
    return this.db.waitForInit();
  }

  /**
   * Escape hatch for code paths that need the underlying worker
   * (queries, version vectors, `applyCommit`). Prefer adding a
   * dedicated method to this class over reaching for the raw
   * worker — those are exactly the call sites this chokepoint is
   * designed to absorb later.
   */
  get raw(): ClientDbWorker {
    return this.db;
  }
}
