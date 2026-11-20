import { decodeB64 } from './base64.js';
import { LoroLoader } from './loro-loader.js';
import {
  parseAttachmentManifest,
  type AttachmentManifest,
} from './resource-attachment-evidence.js';
import type { ReplicaIdentity } from './replica-evidence.js';
import type { Resource } from './resource.js';

/** Causal counters belong to one resource document, never to a whole drive. */
export type PersistenceVersion = Readonly<Record<string, number>>;
export type PersistenceBoundary = 'accepted' | 'stored';
export interface PersistenceReceipt {
  readonly version: PersistenceVersion;
  readonly confirmedAt?: number;
  /** A stored receipt names the completed adapter barrier. */
  readonly barrier?: string;
}

export function persistenceVersion(
  input: ReadonlyMap<string, number> | PersistenceVersion,
): PersistenceVersion | undefined {
  const entries = input instanceof Map ? [...input] : Object.entries(input);
  if (
    !entries.length ||
    entries.some(
      ([peer, n]) =>
        !/^(0|[1-9][0-9]*)$/.test(peer) ||
        BigInt(peer) > 18446744073709551615n ||
        !Number.isSafeInteger(n) ||
        n < 0 ||
        n > 2147483647,
    )
  )
    return;

  return Object.freeze(Object.fromEntries(entries));
}

export function decodePersistenceVersion(
  encoded: string,
): PersistenceVersion | undefined {
  try {
    return persistenceVersion(
      LoroLoader.Loro.VersionVector.decode(decodeB64(encoded)).toJSON(),
    );
  } catch {
    return undefined;
  }
}

export function resourcePersistenceVersion(
  resource: Resource,
): PersistenceVersion | undefined {
  const doc = resource.hasLoroDoc() ? resource.getLoroDoc() : undefined;
  if (!doc || doc.getPendingTxnLength() > 0) return;
  const applied = persistenceVersion(doc.version().toJSON());
  const received = persistenceVersion(doc.oplogVersion().toJSON());

  return persistenceVersionCovers(applied, received) ? applied : undefined;
}

export function persistenceVersionCovers(
  stored: PersistenceVersion | undefined,
  target: PersistenceVersion | undefined,
): boolean {
  return (
    !!stored &&
    !!target &&
    Object.keys(target).length > 0 &&
    Object.entries(target).every(
      ([peer, count]) => (stored[peer] ?? 0) >= count,
    )
  );
}

export interface PersistenceContentReceipt {
  readonly manifest: AttachmentManifest;
  readonly confirmedAt: number;
  readonly replica?: ReplicaIdentity;
  readonly source?: ReplicaIdentity;
}

/** A copy is complete only when both independent dimensions are proven. */
export function persistenceCopyComplete(
  metadata: string,
  contentsRequired: boolean,
  contents?: string,
  expected?: Partial<ReplicaIdentity>,
  observed?: Partial<ReplicaIdentity>,
): boolean {
  if (
    contentsRequired &&
    expected &&
    (!expected.storageId ||
      !expected.generation ||
      expected.storageId !== observed?.storageId ||
      expected.generation !== observed.generation)
  )
    return false;

  return (
    metadata === 'confirmed' && (!contentsRequired || contents === 'confirmed')
  );
}

/** One account's private evidence registry. Adapters own authentication,
 * durability barriers and restoration; this class owns causal coverage and
 * boundary separation. A scope is an unforgeable lifetime token. Replacing or
 * clearing it fences delayed callbacks, including A→B→A transitions.
 *
 * Receipt versions are never combined into a frontier no receiver confirmed.
 * We retain the maximal actual observations, bounded per item. Dropping older
 * evidence can make coverage unknown, never fabricate a positive result.
 */
export class PersistenceEvidenceRegistry {
  private scopes = new Map<string, PersistenceEvidenceScope>();

  open(key: string): PersistenceEvidenceScope {
    this.scopes.get(key)?.close();
    const scope: PersistenceEvidenceScope = new PersistenceEvidenceScope(
      () => this.scopes.get(key) === scope,
      () => {
        if (this.scopes.get(key) === scope) this.scopes.delete(key);
      },
    );
    this.scopes.set(key, scope);

    return scope;
  }

  clear(): void {
    this.scopes.clear();
  }
}

/** Adapter-owned scope; never pass it to untrusted transport input. */
export class PersistenceEvidenceScope {
  private active = true;
  private contents = new Map<string, PersistenceContentReceipt>();
  private rows = new Map<
    string,
    Map<PersistenceBoundary, readonly PersistenceReceipt[]>
  >();
  constructor(
    private current: () => boolean,
    private released: () => void = () => {},
  ) {}

  clear(): void {
    this.rows.clear();
    this.contents.clear();
  }
  close(): void {
    this.active = false;
    this.clear();
    this.released();
  }
  remove(subject: string): void {
    this.rows.delete(subject);
    this.contents.delete(subject);
  }
  removeContents(subject: string): void {
    this.contents.delete(subject);
  }
  clearContents(): void {
    this.contents.clear();
  }
  contentEntries(): IterableIterator<[string, PersistenceContentReceipt]> {
    return (
      this.active && this.current()
        ? this.contents
        : new Map<string, PersistenceContentReceipt>()
    ).entries();
  }
  content(subject: string): PersistenceContentReceipt | undefined {
    return this.active && this.current()
      ? this.contents.get(subject)
      : undefined;
  }
  recordContents(subject: string, receipt: PersistenceContentReceipt): void {
    if (
      !this.active ||
      !this.current() ||
      !subject ||
      !Number.isSafeInteger(receipt.confirmedAt) ||
      receipt.confirmedAt < 0
    )
      return;
    const manifest = parseAttachmentManifest(receipt.manifest);
    if (!manifest) return;
    const previous = this.contents.get(subject);
    if (previous && previous.confirmedAt > receipt.confirmedAt) return;
    this.contents.set(
      subject,
      Object.freeze({
        manifest,
        confirmedAt: receipt.confirmedAt,
        ...(receipt.replica
          ? { replica: Object.freeze({ ...receipt.replica }) }
          : {}),
        ...(receipt.source
          ? { source: Object.freeze({ ...receipt.source }) }
          : {}),
      }),
    );
  }

  record(
    subject: string,
    boundary: PersistenceBoundary,
    receipt: PersistenceReceipt,
  ): void {
    if (
      !this.active ||
      !this.current() ||
      !subject ||
      (boundary === 'stored' && !receipt.barrier)
    )
      return;
    const version = persistenceVersion(receipt.version);
    if (
      !version ||
      (receipt.confirmedAt !== undefined &&
        (!Number.isSafeInteger(receipt.confirmedAt) || receipt.confirmedAt < 0))
    )
      return;
    const row = this.rows.get(subject) ?? new Map();
    const previous = row.get(boundary) ?? [];
    const next = Object.freeze({ ...receipt, version });
    // Preserve a stronger previous proof when a late older acknowledgement lands.
    if (
      previous.some((p: PersistenceReceipt) =>
        persistenceVersionCovers(p.version, version),
      )
    )
      return;
    row.set(
      boundary,
      Object.freeze(
        [
          ...previous.filter(
            (p: PersistenceReceipt) =>
              !persistenceVersionCovers(version, p.version),
          ),
          next,
        ].slice(-16),
      ),
    );
    this.rows.set(subject, row);
  }

  receipts(
    subject: string,
    boundary: PersistenceBoundary,
  ): readonly PersistenceReceipt[] {
    return this.active && this.current()
      ? (this.rows.get(subject)?.get(boundary) ?? [])
      : [];
  }

  covering(
    subject: string,
    boundary: PersistenceBoundary,
    target: PersistenceVersion | undefined,
  ): PersistenceReceipt | undefined {
    return this.receipts(subject, boundary).find(p =>
      persistenceVersionCovers(p.version, target),
    );
  }

  latest(
    subject: string,
    boundary: PersistenceBoundary,
  ): PersistenceReceipt | undefined {
    return this.receipts(subject, boundary).at(-1);
  }
}
