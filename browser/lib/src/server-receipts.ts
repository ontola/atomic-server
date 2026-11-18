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
      state: DriveSyncState;
      subjects: string[];
      cursor: number;
      next: number;
      current: () => boolean;
    }
  >();
  constructor(private readonly store: Store) {}

  reset(): void {
    this.epoch++;
    this.targets.clear();
    this.settled.clear();
    this.seeds.clear();
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    for (const c of this.controllers) c.abort();
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

  seed(endpoint: string, state: DriveSyncState): void {
    const transport = this.store.getServerReceiptTransport(endpoint);
    if (transport?.transport !== 'websocket') return;
    const epoch = this.epoch;
    const identityGeneration = this.store.getIdentityGeneration();
    const databaseGeneration = this.store.getClientDbGeneration();
    const key = JSON.stringify([endpoint, state.drive]);
    this.seeds.set(key, {
      endpoint,
      state,
      subjects: Object.keys(state.vvs ?? state.resources).sort(),
      cursor: this.seeds.get(key)?.cursor ?? 0,
      next: 0,
      current: () =>
        epoch === this.epoch &&
        this.store.getIdentityGeneration() === identityGeneration &&
        this.store.getClientDbGeneration() === databaseGeneration &&
        transport.current(),
    });
    while (this.seeds.size > 16)
      this.seeds.delete(this.seeds.keys().next().value!);
    this.schedule(0);
  }

  private feedSeeds(): void {
    for (const [key, seed] of [...this.seeds]) {
      if (!seed.current()) {
        this.seeds.delete(key);
        continue;
      }

      if (seed.next > Date.now()) continue;
      if (this.targets.size >= LIMIT) break;
      seed.next = Date.now() + 1000;
      const { endpoint, state, subjects } = seed;
      // Rotate both inventories and subjects without advancing past a full queue.
      this.seeds.delete(key);
      this.seeds.set(key, seed);

      for (let i = 0; i < Math.min(32, subjects.length); i++) {
        if (this.targets.size >= LIMIT) break;
        const resource = subjects[seed.cursor++ % subjects.length];

        try {
          const entries = state.vvs
            ? Object.entries(state.vvs[resource])
            : state.peers.map(
                (p, index) =>
                  [p, state.resources[resource][index]] as [string, number],
              );
          if (entries.some(([, c]) => !Number.isSafeInteger(c) || c < 0))
            continue;
          const vv = new LoroLoader.Loro.VersionVector(
            new Map(
              entries.filter(([, c]) => c > 0) as [`${number}`, number][],
            ),
          );
          this.enqueue(endpoint, state.drive, resource, encodeB64(vv.encode()));
        } catch {
          /* Invalid inventory cannot produce evidence. */
        }
      }
    }
  }

  private enqueue(
    endpoint: string,
    drive: string,
    resource: string,
    vv?: string | null,
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
    });
    this.schedule(0);
  }
  private current(target: Target): boolean {
    return (
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
