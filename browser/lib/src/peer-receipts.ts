import {
  attachmentManifestKey,
  parseAttachmentManifest,
  type AttachmentManifest,
} from './resource-attachment-evidence.js';
import { commits } from './ontologies/commits.js';
import { canonicalizeScheme } from './subject.js';
import { decodeB64, encodeB64 } from './base64.js';
import { LoroLoader } from './loro-loader.js';
import type { DriveSyncState } from './store.js';
import type {
  ReplicaIdentity,
  ReplicaObservation,
} from './replica-evidence.js';
import type { SaveReceipt } from './resource.js';

export type { ReplicaIdentity } from './replica-evidence.js';
import { PEER_STORAGE_BARRIER, Tag, decodeCommit } from './ws-v2.js';

/** Historical storage barrier observed on a currently authenticated connection.
 * Covers resource metadata only, not attachments, retention or backup recovery.
 */
export interface BrowserReplicaReceipt {
  readonly observation: ReplicaObservation;
  readonly subject: string;
  readonly manifest?: AttachmentManifest;
  readonly version: string;
  readonly source: ReplicaIdentity;
  readonly replica: ReplicaIdentity;
  readonly peerAgent: string;
  readonly drive: string;
  readonly connectionId: string;
  readonly confirmedAt: number;
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
  manifest?: AttachmentManifest;
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
  attachmentManifest?: (subject: string) => AttachmentManifest | undefined;
  drive: string;
  connectionId: string;
  current: () => boolean;
  getSource: () => Promise<ReplicaIdentity | undefined>;
  canSend: (subject: string) => Promise<boolean>;
  send: (frame: Uint8Array) => Promise<void>;
  onReceipt?: (receipt: BrowserReplicaReceipt) => void;
  onSourceChanged?: () => void;
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

const keyOf = (target: Pick<Target, 'subject' | 'version' | 'manifest'>) =>
  JSON.stringify(
    target.manifest
      ? [target.subject, target.version, target.manifest]
      : [target.subject, target.version],
  );

/** Connection-scoped bounded best-effort probing. Exact requested versions remain separate while newer reconciliation targets arrive.
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
  private subjectEpochs = new Map<string, number>();

  constructor(private readonly deps: ReceiptDependencies) {}

  enable(peerAgent: string): void {
    if (!this.closed && peerAgent) this.peerAgent = peerAgent;
  }

  close(): void {
    this.closed = true;
    this.targets.clear();
    this.pending.clear();
    this.settled.clear();
    this.subjectEpochs.clear();
  }

  /** Discard in-flight proof when a resource is removed, including remove/readd. */
  remove(subject: string): void {
    const normalized = canonicalizeScheme(subject);
    this.subjectEpochs.set(
      normalized,
      (this.subjectEpochs.get(normalized) ?? 0) + 1,
    );

    for (const [key, target] of this.targets) {
      if (
        canonicalizeScheme(target.subject) !== normalized &&
        !target.manifest?.files.some(
          file => canonicalizeScheme(file.subject) === normalized,
        )
      )
        continue;
      if (target.nonce) this.pending.delete(target.nonce);
      this.targets.delete(key);
    }

    for (const key of this.settled.keys()) {
      if (
        canonicalizeScheme(JSON.parse(key)[0]) === normalized ||
        (JSON.parse(key)[2] as AttachmentManifest | undefined)?.files.some(
          file => canonicalizeScheme(file.subject) === normalized,
        )
      )
        this.settled.delete(key);
    }
  }

  /** Capture the exact signed update before async authorization/send. The returned
   * function queues a probe only after send succeeds and the resource still
   * belongs to the same local lifecycle. This never acknowledges any data.
   */
  captureFrame(subject: string, frame: Uint8Array): () => void {
    if (frame[0] !== Tag.COMMIT) return () => {};
    const normalized = canonicalizeScheme(subject);
    const epoch = this.subjectEpochs.get(normalized) ?? 0;

    try {
      const decoded = decodeCommit(frame.subarray(1));
      if (!decoded) return () => {};
      const commit = JSON.parse(decoded.commitJson);
      const encoded = commit[commits.properties.loroUpdate];

      if (
        commit[commits.properties.destroy] ||
        typeof encoded !== 'string' ||
        typeof commit[commits.properties.subject] !== 'string' ||
        canonicalizeScheme(commit[commits.properties.subject]) !== normalized
      )
        return () => {};

      const version = encodeB64(
        LoroLoader.Loro.decodeImportBlobMeta(
          decodeB64(encoded),
          true,
        ).partialEndVersionVector.encode(),
      );

      return () => {
        if ((this.subjectEpochs.get(normalized) ?? 0) !== epoch) return;
        this.observe(subject, version);
      };
    } catch {
      return () => {};
    }
  }

  /** Queue a known exact frontier; never substitute a later live document. */
  observe(receipt: SaveReceipt): void;
  observe(subject: string, version: string | null | undefined): void;
  observe(
    subjectOrReceipt: string | SaveReceipt,
    version?: string | null,
  ): void {
    if (typeof subjectOrReceipt === 'string') {
      this.enqueue(subjectOrReceipt, version);
    } else {
      this.enqueue(subjectOrReceipt.subject, subjectOrReceipt.local?.version);
      this.enqueue(subjectOrReceipt.subject, subjectOrReceipt.server?.version);
    }
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
    const manifest = this.deps.attachmentManifest?.(subject);
    if (this.deps.attachmentManifest && (!manifest || !manifest.files.length))
      return;
    const key = keyOf({ subject, version, manifest });
    if (
      (this.settled.get(key) ?? 0) > Date.now() ||
      this.targets.has(key) ||
      this.targets.size >= PEER_RECEIPT_MAX_TARGETS
    )
      return;
    this.settled.delete(key);
    this.targets.set(key, { subject, version, manifest, attempts: 0 });
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

  private updateSource(source: ReplicaIdentity | undefined): void {
    if (this.source && (!source || !sameIdentity(this.source, source))) {
      this.targets.clear();
      this.pending.clear();
      this.settled.clear();

      try {
        this.deps.onSourceChanged?.();
      } catch {
        // Evidence subscriptions cannot interrupt a transport.
      }
    }

    this.source = source;
  }

  async tick(): Promise<void> {
    if (this.closed || !this.peerAgent || !this.deps.current() || this.pumping)
      return;
    this.pumping = true;

    try {
      const source = identity(await this.deps.getSource());
      if (this.closed || !this.deps.current()) return;
      this.updateSource(source);
      if (!source) return;

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
        if (this.targets.get(key) !== target) continue;

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
            ...(target.manifest ? { manifest: target.manifest } : {}),
          }),
        );

        if (bytes.length + 1 > MAX_FRAME) {
          this.settle(
            key,
            this.deps.attachmentManifest ? Date.now() + 10_000 : Infinity,
          );
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
          new Uint8Array([
            this.deps.attachmentManifest ? 0x58 : Tag.STORAGE_RECEIPT_REQUEST,
            ...bytes,
          ]),
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
      frame[0] !==
        (this.deps.attachmentManifest ? 0x59 : Tag.STORAGE_RECEIPT_RESPONSE) ||
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
        response.barrier !==
          (this.deps.attachmentManifest
            ? 'atomic-attachment-flush-v1'
            : PEER_STORAGE_BARRIER)
      )
        return;

      if (pending.target.manifest) {
        const manifest = parseAttachmentManifest(response.manifest);
        if (
          !manifest ||
          attachmentManifestKey(manifest) !==
            attachmentManifestKey(pending.target.manifest)
        )
          return;
      }

      const replica = identity(response.replica);
      if (!replica) return;
      // Consume before awaiting the identity query: replayed frames cannot race.
      this.pending.delete(response.nonce);
      const key = keyOf(pending.target);
      const source = identity(
        await this.deps.getSource().catch(() => undefined),
      );
      pending.target.nonce = undefined;
      if (!this.closed && this.deps.current()) this.updateSource(source);
      if (
        this.closed ||
        !this.deps.current() ||
        !source ||
        !sameIdentity(source, pending.source) ||
        this.targets.get(key) !== pending.target
      )
        return;
      this.settle(
        key,
        this.deps.attachmentManifest ? Date.now() + 10_000 : Infinity,
      );
      // Fill the freed bounded slot without waiting for the next inventory poll.
      void this.tick();
      const observation: ReplicaObservation = Object.freeze({
        provider: this.deps.attachmentManifest
          ? 'browser-peer-attachment-storage'
          : 'browser-peer-storage',
        capability: 'supported',
        evidenceId: `${this.deps.connectionId}:${response.nonce}`,
        replica,
        barrier: Object.freeze({
          name: this.deps.attachmentManifest
            ? 'atomic-attachment-flush-v1'
            : PEER_STORAGE_BARRIER,
          subject: pending.target.subject,
          version: pending.target.version,
          storage: 'persistent',
          state: 'completed',
        }),
      });
      const callback = this.deps.onReceipt?.(
        Object.freeze({
          observation,
          subject: pending.target.subject,
          ...(pending.target.manifest
            ? { manifest: pending.target.manifest }
            : {}),
          version: pending.target.version,
          replica,
          source,
          peerAgent: this.peerAgent,
          drive: this.deps.drive,
          connectionId: this.deps.connectionId,
          confirmedAt: Date.now(),
        }),
      );
      void Promise.resolve(callback).catch(() => {});
    } catch {
      // Malformed/unsolicited evidence and application callback failures never
      // fail synchronization or cause accepted writes to be replayed.
    }
  }
}
