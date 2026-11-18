import { decodeB64, encodeB64 } from './base64.js';
import { LoroLoader } from './loro-loader.js';
import type {
  ReplicaIdentity,
  ReplicaObservation,
} from './replica-evidence.js';
import type { SaveReceipt } from './resource.js';
import type { DriveSyncState } from './store.js';
import { PEER_STORAGE_BARRIER, Tag } from './ws-v2.js';

/** Authenticated transport evidence, not an independence assessment. The caller
 * still owns trust, authorization, generation and failure-domain policy. */
export interface BrowserReplicaReceipt {
  readonly observation: ReplicaObservation;
  readonly source: ReplicaIdentity;
  readonly peerAgent: string;
  readonly drive: string;
  readonly connectionId: string;
}

export const PEER_RECEIPT_MAX_TARGETS = 128;
export const PEER_RECEIPT_MAX_PENDING = 4;
export const PEER_RECEIPT_TIMEOUT_MS = 6000;
const MAX_ATTEMPTS = 3;
const MAX_FRAME = 64 * 1024;
const MAX_VERSION = 16 * 1024;
const MAX_SUBJECT = 4096;
const HEX_ID = /^[0-9a-f]{64}$/;
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });

function validSubject(subject: unknown): subject is string {
  return (
    typeof subject === 'string' &&
    subject.length > 0 &&
    subject.length <= MAX_SUBJECT &&
    encoder.encode(subject).length <= MAX_SUBJECT
  );
}

interface Target {
  subject: string;
  version: string;
  attempts: number;
  nonce?: string;
}
interface Pending {
  target: Target;
  source: ReplicaIdentity;
  expires: number;
}
interface ReceiptDependencies {
  drive: string;
  connectionId: string;
  current: () => boolean;
  getSource: () => Promise<ReplicaIdentity | undefined>;
  canSend: (subject: string) => Promise<boolean>;
  send: (frame: Uint8Array) => Promise<void>;
  onReceipt?: (receipt: BrowserReplicaReceipt) => void;
}

function nonce(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(32)), byte =>
    byte.toString(16).padStart(2, '0'),
  ).join('');
}

function identity(
  value: ReplicaIdentity | undefined,
): ReplicaIdentity | undefined {
  if (
    !value ||
    typeof value.storageId !== 'string' ||
    typeof value.generation !== 'string' ||
    !HEX_ID.test(value.storageId) ||
    !HEX_ID.test(value.generation)
  )
    return;

  return Object.freeze({
    storageId: value.storageId,
    generation: value.generation,
  });
}

function sameIdentity(left: ReplicaIdentity, right: ReplicaIdentity): boolean {
  return (
    left.storageId === right.storageId && left.generation === right.generation
  );
}

function validVersion(version: unknown): version is string {
  if (
    typeof version !== 'string' ||
    !version ||
    version.length > MAX_VERSION ||
    !/^[A-Za-z0-9+/]+={0,2}$/.test(version)
  )
    return false;

  try {
    const bytes = decodeB64(version);
    if (encodeB64(bytes) !== version) return false;
    const entries = LoroLoader.Loro.VersionVector.decode(bytes).toJSON();
    if (
      !entries.size ||
      [...entries.values()].some(
        counter => !Number.isSafeInteger(counter) || counter <= 0,
      )
    )
      return false;

    return true;
  } catch {
    return false;
  }
}

const keyOf = (target: Pick<Target, 'subject' | 'version'>) =>
  JSON.stringify([target.subject, target.version]);

/** Connection-scoped bounded best-effort probing. Exact save versions are queued
 * separately; current reconciliation state cannot replace an earlier C1 with C2.
 * No receipts or historical targets are promised across close/reload/overflow. */
export class PeerReceiptRequests {
  private peerAgent?: string;
  private closed = false;
  private pumping = false;
  private source?: ReplicaIdentity;
  private targets = new Map<string, Target>();
  private pending = new Map<string, Pending>();
  /** Successful versions are suppressed; exhausted retries cool down for 30s. */
  private settled = new Map<string, number>();
  private seedCursor = 0;

  constructor(private readonly deps: ReceiptDependencies) {}

  enable(peerAgent: string): void {
    if (!this.closed && peerAgent) this.peerAgent = peerAgent;
  }

  close(): void {
    this.closed = true;
    this.targets.clear();
    this.pending.clear();
    this.settled.clear();
  }

  observe(receipt: SaveReceipt): void {
    this.enqueue(receipt.subject, receipt.local?.version);
    this.enqueue(receipt.subject, receipt.server?.version);
  }

  private enqueue(subject: string, version: string | null | undefined): void {
    if (
      this.closed ||
      !this.deps.current() ||
      !validSubject(subject) ||
      !validSubject(this.deps.drive) ||
      !validVersion(version)
    )
      return;
    const key = keyOf({ subject, version });
    if (
      (this.settled.get(key) ?? 0) > Date.now() ||
      this.targets.has(key) ||
      this.targets.size >= PEER_RECEIPT_MAX_TARGETS
    )
      return;
    this.settled.delete(key);
    this.targets.set(key, { subject, version, attempts: 0 });
  }

  /** Dense VVs already exclude outbox-owned subjects. Rotate through the whole
   * inventory instead of starving later subjects behind a fixed first batch. */
  seed(state: DriveSyncState): void {
    if (state.drive !== this.deps.drive || this.closed) return;
    const subjects = Object.keys(state.resources).sort();
    if (!subjects.length) return;

    for (let count = 0; count < Math.min(32, subjects.length); count++) {
      const subject = subjects[this.seedCursor++ % subjects.length];

      try {
        const counters = state.resources[subject];
        if (
          counters.length !== state.peers.length ||
          counters.some(value => !Number.isSafeInteger(value) || value < 0)
        )
          continue;
        const entries = state.peers.flatMap(
          (peer, index): [`${number}`, number][] =>
            counters[index] > 0 ? [[peer as `${number}`, counters[index]]] : [],
        );
        if (!entries.length) continue;
        const vv = new LoroLoader.Loro.VersionVector(new Map(entries));
        this.enqueue(subject, encodeB64(vv.encode()));
      } catch {
        // An unencodable inventory entry cannot produce evidence.
      }
    }
  }

  private settle(key: string, until: number): void {
    this.targets.delete(key);
    this.settled.set(key, until);
    while (this.settled.size > PEER_RECEIPT_MAX_TARGETS)
      this.settled.delete(this.settled.keys().next().value!);
  }

  async tick(): Promise<void> {
    if (this.closed || !this.peerAgent || !this.deps.current() || this.pumping)
      return;
    this.pumping = true;

    try {
      const source = identity(await this.deps.getSource());
      if (this.closed || !this.deps.current() || !source) return;

      if (this.source && !sameIdentity(this.source, source)) {
        this.targets.clear();
        this.pending.clear();
        this.settled.clear();
      }

      this.source = source;

      for (const [token, pending] of this.pending) {
        if (pending.expires > Date.now()) continue;
        this.pending.delete(token);
        pending.target.nonce = undefined;
        const key = keyOf(pending.target);
        this.targets.delete(key);
        if (pending.target.attempts >= MAX_ATTEMPTS)
          this.settle(key, Date.now() + 30_000);
        else this.targets.set(key, pending.target);
      }

      for (const [key, target] of this.targets) {
        if (this.pending.size >= PEER_RECEIPT_MAX_PENDING) break;
        if (target.nonce) continue;

        if (target.attempts >= MAX_ATTEMPTS) {
          this.settle(key, Date.now() + 30_000);
          continue;
        }

        const allowed = await this.deps.canSend(target.subject);
        if (this.closed || !this.deps.current()) return;

        if (!allowed) {
          this.settle(key, Date.now() + 30_000);
          continue;
        }

        const token = nonce();
        if (this.pending.has(token)) continue;
        const bytes = encoder.encode(
          JSON.stringify({
            nonce: token,
            drive: this.deps.drive,
            subject: target.subject,
            version: target.version,
          }),
        );

        if (bytes.length + 1 > MAX_FRAME) {
          this.settle(key, Infinity);
          continue;
        }

        target.nonce = token;
        target.attempts++;
        this.pending.set(token, {
          target,
          source,
          expires: Date.now() + PEER_RECEIPT_TIMEOUT_MS,
        });
        await this.deps.send(
          new Uint8Array([Tag.STORAGE_RECEIPT_REQUEST, ...bytes]),
        );
        if (this.closed || !this.deps.current()) return;
      }
    } catch {
      // A failed probe is not a failed save/sync. The bounded timer retries it.
    } finally {
      this.pumping = false;
    }
  }

  async receive(frame: Uint8Array): Promise<void> {
    if (
      this.closed ||
      !this.peerAgent ||
      !this.deps.current() ||
      frame[0] !== Tag.STORAGE_RECEIPT_RESPONSE ||
      frame.length > MAX_FRAME
    )
      return;

    try {
      const response = JSON.parse(decoder.decode(frame.subarray(1)));
      const pending =
        typeof response?.nonce === 'string' && HEX_ID.test(response.nonce)
          ? this.pending.get(response.nonce)
          : undefined;
      if (
        !pending ||
        pending.expires <= Date.now() ||
        response.drive !== this.deps.drive ||
        response.subject !== pending.target.subject ||
        response.version !== pending.target.version ||
        response.barrier !== PEER_STORAGE_BARRIER
      )
        return;
      const replica = identity(response.replica);
      if (!replica) return;
      // Consume before awaiting the identity query: replayed frames cannot race.
      this.pending.delete(response.nonce);
      const key = keyOf(pending.target);
      const source = identity(
        await this.deps.getSource().catch(() => undefined),
      );
      pending.target.nonce = undefined;
      if (
        this.closed ||
        !this.deps.current() ||
        !source ||
        !sameIdentity(source, pending.source)
      )
        return;
      this.settle(key, Infinity);
      const observation: ReplicaObservation = Object.freeze({
        provider: 'browser-peer-storage',
        capability: 'supported',
        evidenceId: `${this.deps.connectionId}:${response.nonce}`,
        replica,
        barrier: Object.freeze({
          name: PEER_STORAGE_BARRIER,
          subject: pending.target.subject,
          version: pending.target.version,
          storage: 'persistent',
          state: 'completed',
        }),
      });
      const callback = this.deps.onReceipt?.(
        Object.freeze({
          observation,
          source,
          peerAgent: this.peerAgent,
          drive: this.deps.drive,
          connectionId: this.deps.connectionId,
        }),
      );
      void Promise.resolve(callback).catch(() => {});
    } catch {
      // Malformed/unsolicited evidence and application callback failures never
      // fail synchronization or cause accepted writes to be replayed.
    }
  }
}
