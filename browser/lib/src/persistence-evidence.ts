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
interface MetadataProof {
  readonly boundary: PersistenceBoundary;
  readonly version: PersistenceVersion;
  readonly manifest?: never;
  readonly barrier?: string;
}

interface ContentProof {
  readonly boundary: 'stored';
  readonly manifest: AttachmentManifest;
  readonly version?: never;
  readonly barrier: string;
  readonly confirmedAt: number;
}

type ReceiptProof = (MetadataProof | ContentProof) & {
  readonly confirmedAt?: number;
  readonly replica?: ReplicaIdentity;
  readonly source?: ReplicaIdentity;
};

/** A version or file-manifest observation for one resource at one destination.
 * Only a stored receipt names a completed storage barrier. File proof is
 * independent of metadata coverage and can outlive metadata-only edits.
 */
export type Receipt = ReceiptProof & {
  readonly destination: string;
  readonly subject: string;
};

type MetadataReceipt = Receipt & MetadataProof;

export type ContentReceipt = Receipt & ContentProof;

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

  open(key: string, destination = key): PersistenceEvidenceScope {
    this.scopes.get(key)?.close();
    const scope: PersistenceEvidenceScope = new PersistenceEvidenceScope(
      destination,
      () => this.scopes.get(key) === scope,
      () => {
        if (this.scopes.get(key) === scope) this.scopes.delete(key);
      },
    );
    this.scopes.set(key, scope);

    return scope;
  }

  clear(): void {
    for (const scope of this.scopes.values()) scope.close();
  }
}

/** Adapter-owned scope; never pass it to untrusted transport input. */
export class PersistenceEvidenceScope {
  private active = true;
  private rows = new Map<string, readonly Receipt[]>();

  constructor(
    private destination: string,
    private current: () => boolean,
    private released: () => void = () => {},
  ) {}

  clear(): void {
    this.rows.clear();
  }
  close(): void {
    this.active = false;
    this.clear();
    this.released();
  }
  remove(subject: string): void {
    this.rows.delete(subject);
  }
  removeContents(subject: string): void {
    const rows = this.rows.get(subject);
    if (!rows) return;
    const retained = rows.filter(receipt => !receipt.manifest);
    if (retained.length) this.rows.set(subject, retained);
    else this.rows.delete(subject);
  }
  clearContents(): void {
    for (const subject of this.rows.keys()) this.removeContents(subject);
  }
  *contentEntries(): IterableIterator<[string, ContentReceipt]> {
    if (!this.active || !this.current()) return;

    for (const [subject, rows] of this.rows) {
      const proof = rows.find(isContentReceipt);
      if (proof) yield [subject, proof];
    }
  }
  content(subject: string): ContentReceipt | undefined {
    return this.active && this.current()
      ? this.rows.get(subject)?.find(isContentReceipt)
      : undefined;
  }

  record(subject: string, proof: ReceiptProof): void {
    const { boundary, barrier, confirmedAt } = proof;
    if (
      !this.active ||
      !this.current() ||
      !subject ||
      (boundary === 'stored' && !barrier) ||
      (confirmedAt !== undefined &&
        (!Number.isSafeInteger(confirmedAt) || confirmedAt < 0))
    )
      return;
    const rows = this.rows.get(subject) ?? [];
    const scoped = {
      destination: this.destination,
      subject,
      ...(proof.replica && { replica: Object.freeze({ ...proof.replica }) }),
      ...(proof.source && { source: Object.freeze({ ...proof.source }) }),
    };

    if (proof.manifest !== undefined) {
      const manifest = parseAttachmentManifest(proof.manifest);
      const previous = rows.find(isContentReceipt);
      if (
        boundary !== 'stored' ||
        !manifest ||
        !Number.isSafeInteger(proof.confirmedAt) ||
        (previous && previous.confirmedAt > proof.confirmedAt)
      )
        return;

      this.rows.set(subject, [
        ...rows.filter(isMetadataReceipt),
        Object.freeze({
          ...scoped,
          boundary: 'stored',
          barrier: proof.barrier,
          confirmedAt: proof.confirmedAt,
          manifest,
        }),
      ]);

      return;
    }

    const version = persistenceVersion(proof.version);
    if (!version) return;
    const previous = rows.filter(
      (receipt): receipt is MetadataReceipt =>
        isMetadataReceipt(receipt) && receipt.boundary === boundary,
    );
    // Preserve a stronger previous proof when a late older acknowledgement lands.
    if (
      previous.some(receipt =>
        persistenceVersionCovers(receipt.version, version),
      )
    )
      return;

    const observations = previous.filter(
      receipt => !persistenceVersionCovers(version, receipt.version),
    );
    observations.push(
      Object.freeze({ ...scoped, boundary, barrier, confirmedAt, version }),
    );
    this.rows.set(subject, [
      ...rows.filter(
        receipt => !isMetadataReceipt(receipt) || receipt.boundary !== boundary,
      ),
      ...observations.slice(-16),
    ]);
  }

  receipts(
    subject: string,
    boundary: PersistenceBoundary,
  ): readonly MetadataReceipt[] {
    return this.active && this.current()
      ? (this.rows
          .get(subject)
          ?.filter(
            (receipt): receipt is MetadataReceipt =>
              isMetadataReceipt(receipt) && receipt.boundary === boundary,
          ) ?? [])
      : [];
  }

  covering(
    subject: string,
    boundary: PersistenceBoundary,
    target: PersistenceVersion | undefined,
  ): MetadataReceipt | undefined {
    return this.receipts(subject, boundary).find(p =>
      persistenceVersionCovers(p.version, target),
    );
  }

  /** Display the time of the observation that proves the requested version. */
  readMetadata(
    subject: string,
    boundary: PersistenceBoundary,
    target: PersistenceVersion | undefined,
  ) {
    const receipts = this.receipts(subject, boundary);
    const covering = receipts.find(receipt =>
      persistenceVersionCovers(receipt.version, target),
    );
    const observed = covering ?? receipts.at(-1);
    const state = covering ? 'confirmed' : observed ? 'pending' : 'unknown';

    return { state, confirmedAt: observed?.confirmedAt } as const;
  }

  latest(
    subject: string,
    boundary: PersistenceBoundary,
  ): MetadataReceipt | undefined {
    return this.receipts(subject, boundary).at(-1);
  }
}

function isContentReceipt(receipt: Receipt): receipt is ContentReceipt {
  return receipt.manifest !== undefined;
}

function isMetadataReceipt(receipt: Receipt): receipt is MetadataReceipt {
  return receipt.version !== undefined;
}
