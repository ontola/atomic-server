import type { Agent } from './agent.js';
import { decodeB64, encodeB64 } from './base64.js';
import { LoroLoader } from './loro-loader.js';
import type {
  ReplicaIdentity,
  ReplicaObservation,
} from './replica-evidence.js';
import type { SaveReceipt } from './resource.js';
import type { DriveSyncState, Store } from './store.js';
import { PEER_STORAGE_BARRIER } from './ws-v2.js';

export const SERVER_RECEIPT_CAPABILITY = 'server-storage-receipts-v1';
export const SERVER_RECEIPT_HEADER = 'X-Atomic-Storage-Receipts';
export const SERVER_RECEIPT_MAX_FRAME = 64 * 1024;
const LIMIT = 128;
const INFLIGHT = 4;
const TIMEOUT = 6000;
const encoder = new TextEncoder();
const hex = /^[0-9a-f]{64}$/;

/** Historical authenticated server storage evidence. This does not establish
 * physical independence, current retention, blobs, or recoverable backups. */
export interface ServerReplicaReceipt {
  readonly drive: string;
  readonly observation: ReplicaObservation;
  readonly source?: ReplicaIdentity;
  readonly endpoint: string;
  readonly serverOrigin: string;
  readonly transport: 'http' | 'websocket';
  readonly clientAgent: string;
  readonly identityGeneration: number;
  readonly databaseGeneration: number;
  readonly connectionId: string;
}

/** @internal Shared bounded wire envelope for HTTP and WebSocket adapters. */
export interface ServerReceiptRequest {
  nonce: string;
  drive: string;
  subject: string;
  version: string;
}
export interface ServerReceiptWire extends ServerReceiptRequest {
  replica: ReplicaIdentity;
  barrier: string;
}
export interface ServerReceiptTransport {
  endpoint: string;
  transport: 'http' | 'websocket';
  connectionId: string;
  current(): boolean;
  request(
    request: ServerReceiptRequest,
    agent: Agent,
    signal: AbortSignal,
    current: () => boolean,
  ): Promise<ServerReceiptWire | undefined>;
}

function identity(value: unknown): ReplicaIdentity | undefined {
  if (!value || typeof value !== 'object') return;
  const r = value as ReplicaIdentity;
  if (
    typeof r.storageId !== 'string' ||
    typeof r.generation !== 'string' ||
    !hex.test(r.storageId) ||
    !hex.test(r.generation)
  )
    return;

  return Object.freeze({ storageId: r.storageId, generation: r.generation });
}

function sameIdentity(a?: ReplicaIdentity, b?: ReplicaIdentity): boolean {
  return a?.storageId === b?.storageId && a?.generation === b?.generation;
}

function subject(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    !!value &&
    !/[?#]/.test(value) &&
    encoder.encode(value).length <= 4096
  );
}

function version(value: unknown): value is string {
  if (typeof value !== 'string' || !value || value.length > 16 * 1024)
    return false;

  try {
    const bytes = decodeB64(value);
    if (encodeB64(bytes) !== value) return false;
    const vv = LoroLoader.Loro.VersionVector.decode(bytes).toJSON();

    return (
      vv.size > 0 &&
      [...vv.values()].every(c => Number.isSafeInteger(c) && c > 0)
    );
  } catch {
    return false;
  }
}

/** @internal Decode only the bounded known receipt fields. */
export function decodeServerReceipt(
  text: string,
): ServerReceiptWire | undefined {
  if (encoder.encode(text).length >= SERVER_RECEIPT_MAX_FRAME) return;

  try {
    const r = JSON.parse(text);
    if (
      !r ||
      typeof r !== 'object' ||
      Object.keys(r).some(
        k =>
          ![
            'nonce',
            'drive',
            'subject',
            'version',
            'replica',
            'barrier',
          ].includes(k),
      )
    )
      return;
    const replica = identity(r.replica);
    if (
      typeof r.nonce !== 'string' ||
      !hex.test(r.nonce) ||
      !subject(r.drive) ||
      !subject(r.subject) ||
      !version(r.version) ||
      !replica ||
      r.barrier !== PEER_STORAGE_BARRIER
    )
      return;

    return {
      nonce: r.nonce,
      drive: r.drive,
      subject: r.subject,
      version: r.version,
      replica,
      barrier: r.barrier,
    };
  } catch {
    return;
  }
}
/** @internal Correlation precedes consumption and any further identity reads. */
export function matchesServerReceipt(
  request: ServerReceiptRequest,
  receipt: ServerReceiptWire,
): boolean {
  return (
    request.nonce === receipt.nonce &&
    request.drive === receipt.drive &&
    request.subject === receipt.subject &&
    request.version === receipt.version
  );
}
export function serverReceiptEndpoint(commitEndpoint: string): string {
  const url = new URL('/storage-receipt', commitEndpoint);
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password
  )
    throw new Error('Invalid server receipt endpoint');

  return url.href;
}

function nonce(): string {
  return [...crypto.getRandomValues(new Uint8Array(32))]
    .map(v => v.toString(16).padStart(2, '0'))
    .join('');
}

function unref(timer: ReturnType<typeof setTimeout>): void {
  (timer as ReturnType<typeof setTimeout> & { unref?: () => void }).unref?.();
}

interface Target {
  key: string;
  drive: string;
  subject: string;
  version: string;
  agent: Agent;
  identityGeneration: number;
  databaseGeneration: number;
  epoch: number;
  transport: ServerReceiptTransport;
  attempts: number;
  next: number;
  active: boolean;
  followed?: () => boolean;
}

/** @internal Optional bounded evidence collection; never on the save critical path. */
export class ServerReceiptRequests {
  private epoch = 0;
  private targets = new Map<string, Target>();
  private settled = new Map<string, number>();
  private controllers = new Set<AbortController>();
  private timer?: ReturnType<typeof setTimeout>;
  private pending = 0;
  private seeds = new Map<
    string,
    {
      endpoint: string;
      drive: string;
      subjects: string[];
      cursor: number;
      next: number;
      refresh: number;
      current: () => boolean;
    }
  >();
  private readonly reading = new WeakSet<object>();
  constructor(private readonly store: Store) {}

  reset(preserveFollows = false): void {
    this.epoch++;
    this.targets.clear();
    this.settled.clear();

    if (!preserveFollows) this.seeds.clear();
    else
      for (const seed of this.seeds.values()) {
        seed.subjects = [];
        seed.cursor = 0;
        seed.next = 0;
        seed.refresh = 0;
      }

    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    for (const c of this.controllers) c.abort();
    this.schedule(0);
  }

  observe(receipt: SaveReceipt): void {
    // Acceptance supplies the actual destination chosen by this save. A local
    // receipt alone must not silently route to a different default server.
    if (!receipt.server) return;
    const resource = this.store.resources.get(receipt.subject);
    const drive =
      resource?.get('https://atomicdata.dev/properties/drive') ??
      (resource?.getClasses().includes('https://atomicdata.dev/classes/Drive')
        ? receipt.subject
        : undefined);
    if (typeof drive !== 'string') return;
    this.enqueue(
      receipt.server.endpoint,
      drive,
      receipt.subject,
      receipt.server.version,
    );
    this.enqueue(
      receipt.server.endpoint,
      drive,
      receipt.subject,
      receipt.local?.version,
    );
  }

  /** Capture before delivery; invoking after acceptance cannot rebind an old write. */
  captureAccepted(
    endpoint: string,
    drive: string,
    resource: string,
    vv: string,
  ): () => void {
    const epoch = this.epoch;
    const identityGeneration = this.store.getIdentityGeneration();
    const databaseGeneration = this.store.getClientDbGeneration();
    const transport = this.store.getServerReceiptTransport(endpoint);

    return () => {
      if (
        epoch !== this.epoch ||
        identityGeneration !== this.store.getIdentityGeneration() ||
        databaseGeneration !== this.store.getClientDbGeneration() ||
        (transport && !transport.current())
      )
        return;
      this.enqueue(endpoint, drive, resource, vv);
    };
  }

  follow(endpoint: string, drive: string, current: () => boolean): void {
    if (!subject(drive) || !current()) return;
    const key = JSON.stringify([endpoint, drive]);
    const previous = this.seeds.get(key);
    this.seeds.set(
      key,
      previous
        ? { ...previous, current }
        : {
            endpoint,
            drive,
            subjects: [],
            cursor: 0,
            next: 0,
            refresh: 0,
            current,
          },
    );
    while (this.seeds.size > 16)
      this.seeds.delete(this.seeds.keys().next().value!);
    this.schedule(0);
  }

  /** Compatibility hook: reconciliation vectors can include unsaved oplog state.
   * They identify a drive only; receipt targets are always reread from storage. */
  seed(endpoint: string, state: DriveSyncState): void {
    const transport = this.store.getServerReceiptTransport(endpoint);
    if (transport?.transport !== 'websocket') return;
    this.follow(endpoint, state.drive, () => transport.current());
  }

  refresh(): void {
    for (const seed of this.seeds.values()) {
      seed.refresh = 0;
      seed.next = Math.min(seed.next, Date.now() + 1000);
    }

    this.schedule(0);
  }

  private feedSeeds(): void {
    for (const [key, seed] of this.seeds)
      if (!seed.current()) this.seeds.delete(key);
    const db = this.store.getClientDb();
    if (
      !db?.getDriveSubjects ||
      !db.getResourceWithSnapshot ||
      this.reading.has(db)
    )
      return;

    for (const [key, seed] of this.seeds) {
      if (!seed.current()) {
        this.seeds.delete(key);
        continue;
      }

      if (seed.next > Date.now() || this.targets.size >= LIMIT) continue;
      const epoch = this.epoch;
      const identityGeneration = this.store.getIdentityGeneration();
      const databaseGeneration = this.store.getClientDbGeneration();
      const expires = Date.now() + TIMEOUT;
      const current = () =>
        epoch === this.epoch &&
        this.store.getClientDb() === db &&
        this.store.getIdentityGeneration() === identityGeneration &&
        this.store.getClientDbGeneration() === databaseGeneration &&
        seed.current() &&
        this.seeds.get(key) === seed &&
        Date.now() < expires;
      seed.next = Date.now() + 1000;
      this.seeds.delete(key);
      this.seeds.set(key, seed);
      // Keep the actual worker slot occupied until it settles, even after a
      // deadline/reset. Repeated timeouts must not flood a stuck worker queue.
      this.reading.add(db);
      void (async () => {
        if (seed.refresh <= Date.now()) {
          const subjects = await db.getDriveSubjects(seed.drive);
          if (!current()) return;
          seed.subjects = [...subjects].sort();
          seed.cursor %= Math.max(seed.subjects.length, 1);
          seed.refresh = Date.now() + 30_000;
        }

        for (let i = 0; i < Math.min(8, seed.subjects.length); i++) {
          if (!current() || this.targets.size >= LIMIT) return;
          const resource = seed.subjects[seed.cursor % seed.subjects.length];
          const { snapshot } = await db.getResourceWithSnapshot(resource);
          if (!current() || this.targets.size >= LIMIT) return;
          seed.cursor = (seed.cursor + 1) % seed.subjects.length;
          if (!snapshot?.length) continue;
          const doc = new LoroLoader.Loro.LoroDoc();

          try {
            doc.import(snapshot);
            // version() is applied state; oplogVersion() can count unresolved dependencies.
            const entries = [...doc.version().toJSON()]
              .filter(([, count]) => count > 0)
              .sort(([a], [b]) => a.localeCompare(b));
            const vv = new LoroLoader.Loro.VersionVector(new Map(entries));
            this.enqueue(
              seed.endpoint,
              seed.drive,
              resource,
              encodeB64(vv.encode()),
              seed.current,
            );
          } catch {
            /* Missing/incomplete stored state supplies no target. */
          } finally {
            doc.free();
          }
        }
      })()
        .catch(() => undefined)
        .finally(() => {
          this.reading.delete(db);
          this.schedule();
        });
      break;
    }
  }

  private enqueue(
    endpoint: string,
    drive: string,
    resource: string,
    vv?: string | null,
    followed?: () => boolean,
  ): void {
    if (!subject(drive) || !subject(resource) || !version(vv)) return;
    const agent = this.store.getAgent();
    const transport = this.store.getServerReceiptTransport(endpoint);
    if (!agent?.subject || !transport) return;
    const key = JSON.stringify([
      transport.endpoint,
      transport.connectionId,
      drive,
      resource,
      vv,
    ]);
    if (
      this.targets.has(key) ||
      (this.settled.get(key) ?? 0) > Date.now() ||
      this.targets.size >= LIMIT
    )
      return;
    this.targets.set(key, {
      key,
      drive,
      subject: resource,
      version: vv,
      agent,
      transport,
      identityGeneration: this.store.getIdentityGeneration(),
      databaseGeneration: this.store.getClientDbGeneration(),
      epoch: this.epoch,
      attempts: 0,
      next: 0,
      active: false,
      followed,
    });
    this.schedule(0);
  }
  private current(target: Target): boolean {
    return (
      (!target.followed || target.followed()) &&
      target.epoch === this.epoch &&
      this.store.getIdentityGeneration() === target.identityGeneration &&
      this.store.getClientDbGeneration() === target.databaseGeneration &&
      this.store.getAgent()?.subject === target.agent.subject &&
      target.transport.current()
    );
  }
  private schedule(delay = 250): void {
    if (this.timer || (!this.targets.size && !this.seeds.size)) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.pump();
    }, delay);
    unref(this.timer);
  }
  private pump(): void {
    this.feedSeeds();

    for (const [key, target] of this.targets) {
      if (!this.current(target)) {
        this.targets.delete(key);
        continue;
      }

      if (this.pending >= INFLIGHT) break;
      if (target.active || target.next > Date.now()) continue;
      target.active = true;
      target.attempts++;
      this.pending++;
      void this.request(target)
        .then(completed => {
          if (!this.current(target)) return;
          if (completed || target.attempts >= 3) {
            this.targets.delete(key);
            this.settled.set(key, completed ? Infinity : Date.now() + 30_000);
            while (this.settled.size > LIMIT)
              this.settled.delete(this.settled.keys().next().value!);
          } else target.next = Date.now() + 1000;
        })
        .finally(() => {
          target.active = false;
          this.pending--;
          this.schedule();
        });
    }

    this.schedule();
  }
  private async request(target: Target): Promise<boolean> {
    const controller = new AbortController();
    this.controllers.add(controller);
    const timer = setTimeout(() => controller.abort(), TIMEOUT);
    unref(timer);
    const expires = Date.now() + TIMEOUT;
    const current = () =>
      !controller.signal.aborted &&
      Date.now() < expires &&
      this.current(target);
    let abort: (() => void) | undefined;
    const cancelled = new Promise<boolean>(resolve => {
      abort = () => resolve(false);
      controller.signal.addEventListener('abort', abort, { once: true });
    });

    const work = async (): Promise<boolean> => {
      const db = this.store.getClientDb();
      const source = identity(await db?.getReplicaIdentity?.(target.drive));
      if (!current()) return false;
      const request = {
        nonce: nonce(),
        drive: target.drive,
        subject: target.subject,
        version: target.version,
      };
      const receipt = await target.transport.request(
        request,
        target.agent,
        controller.signal,
        current,
      );
      if (!receipt || !matchesServerReceipt(request, receipt) || !current())
        return false;
      const after = identity(await db?.getReplicaIdentity?.(target.drive));
      if (!current() || !sameIdentity(source, after)) return false;
      const observation: ReplicaObservation = Object.freeze({
        provider: 'atomic-server-storage-v1',
        capability: 'supported',
        evidenceId: `${target.transport.connectionId}:${receipt.nonce}`,
        replica: Object.freeze({ ...receipt.replica }),
        barrier: Object.freeze({
          name: receipt.barrier,
          subject: receipt.subject,
          version: receipt.version,
          storage: 'persistent',
          state: 'completed',
        }),
      });
      this.store.notifyServerReplicaReceipt(
        Object.freeze({
          observation,
          drive: target.drive,
          ...(source ? { source } : {}),
          endpoint: target.transport.endpoint,
          serverOrigin: new URL(target.transport.endpoint).origin,
          transport: target.transport.transport,
          clientAgent: target.agent.subject!,
          identityGeneration: target.identityGeneration,
          databaseGeneration: target.databaseGeneration,
          connectionId: target.transport.connectionId,
        }),
      );

      return true;
    };

    try {
      return await Promise.race([work().catch(() => false), cancelled]);
    } finally {
      controller.abort();
      if (abort) controller.signal.removeEventListener('abort', abort);
      clearTimeout(timer);
      this.controllers.delete(controller);
    }
  }
}
